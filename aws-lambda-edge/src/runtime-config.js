// De dónde sale la config en runtime.
//
// Lambda@Edge no soporta variables de entorno, así que hay dos orígenes:
//
//   1. HORNEADA en el bundle (`npm run build -- --client ... --private-key ...`).
//      Es el modo de siempre: la config viaja dentro del zip.
//   2. AWS SECRETS MANAGER, cuando el bundle viene sin configurar (el que
//      instala el botón de CloudFormation). La clave queda en el secreto del
//      cliente y no dentro de ningún zip.
//
// Si la config horneada es válida, manda. Si no, se busca el secreto. Si
// tampoco hay secreto, se devuelve null y el handler deja pasar todo: un conector
// mal configurado nunca bloquea el sitio del cliente.

import { createHash, createHmac } from "node:crypto";
import { validateConfig } from "@vqueue/connector-core/config";

// Nombre fijo: el bundle no se puede parametrizar por instalación y el template
// crea el secreto con este mismo nombre.
export const SECRET_NAME = "vqueue/connector";
// El secreto vive en us-east-1 (donde se despliega Lambda@Edge). Las réplicas
// corren en otras regiones, así que no se puede confiar en AWS_REGION.
export const SECRET_REGION = "us-east-1";

const REFRESH_MS = 300_000; // una rotación de clave se toma en a lo sumo 5 min
const RETRY_MS = 30_000; // tras un fallo no se reintenta en cada request
const FETCH_TIMEOUT_MS = 2_000;

// ─── Lectura del secreto, firmando la llamada a mano (SigV4) ─────────────────
//
// NO se usa el SDK de AWS a propósito. Medido en una función real de 128 MB (el
// máximo de un viewer-request): `import("@aws-sdk/client-secrets-manager")` tarda
// ~2.5 s y la primera llamada ~0.9 s más. El límite de un viewer-request es 5 s,
// así que la primera visita a cada contenedor se acercaba al corte, y un timeout
// de Lambda@Edge NO cae en el fail-open: CloudFront le devuelve un 503 al
// visitante. Firmar a mano con node:crypto y `fetch` evita la carga del SDK.

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/**
 * Firma un request con AWS Signature V4. Devuelve los headers a enviar
 * (sin `host`, que el cliente HTTP arma solo a partir de la URL).
 *
 * @param {object} r  method, host, path, query ("" o "a=b&c=d" ya ordenado y codificado),
 *                    headers (minúsculas), body, region, service
 * @param {object} credentials  accessKeyId, secretAccessKey, sessionToken?
 * @param {Date} date
 */
export function signV4(r, credentials, date) {
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20150830T123600Z
    const day = amzDate.slice(0, 8);

    const headers = { ...r.headers, host: r.host, "x-amz-date": amzDate };
    if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
    const signedHeaders = names.join(";");

    const canonicalRequest = [r.method, r.path, r.query, canonicalHeaders, signedHeaders, sha256Hex(r.body ?? "")].join("\n");
    const scope = `${day}/${r.region}/${r.service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    const kSigning = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), r.region), r.service), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");

    const { host, ...toSend } = headers;
    toSend.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return toSend;
}

/**
 * Lee el secreto con una llamada firmada a Secrets Manager. Las credenciales son
 * las del rol de la función, que Lambda deja en el entorno.
 */
export async function fetchSecretFromSecretsManager(
    name = SECRET_NAME,
    { region = SECRET_REGION, env = process.env, now = () => new Date(), fetchImpl = fetch } = {},
) {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        throw new Error("el runtime no expone credenciales del rol");
    }

    const host = `secretsmanager.${region}.amazonaws.com`;
    const body = JSON.stringify({ SecretId: name });

    const headers = signV4(
        {
            method: "POST",
            host,
            path: "/",
            query: "",
            headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.GetSecretValue" },
            body,
            region,
            service: "secretsmanager",
        },
        { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN },
        now(),
    );

    const resp = await fetchImpl(`https://${host}/`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
        // El cuerpo trae el motivo (AccessDeniedException, ResourceNotFoundException).
        const detail = await resp.text().catch(() => "");
        throw new Error(`Secrets Manager respondió ${resp.status}: ${detail.slice(0, 200)}`);
    }

    return (await resp.json()).SecretString;
}

/**
 * Devuelve `getConfig()`: una función async que resuelve la config válida o null.
 * El estado (cache, fallos) vive en la closure, una por contenedor.
 */
export function createConfigProvider(baked, { fetchSecret = fetchSecretFromSecretsManager, now = Date.now, logger = console } = {}) {
    // Horneada y válida: no hay nada que buscar.
    if (validateConfig(baked).ok) return async () => baked;

    let entry = { config: null, expire: 0 };
    let inflight = null;

    async function load() {
        try {
            const raw = await fetchSecret();
            const secret = JSON.parse(raw);
            const config = {
                ...baked,
                client: secret.client,
                privateKey: secret.privateKey,
                ...(secret.adminHost ? { adminHost: secret.adminHost } : {}),
            };

            const check = validateConfig(config);
            if (!check.ok) throw new Error(check.errors.join("; "));

            entry = { config, expire: now() + REFRESH_MS };
        } catch (err) {
            // Si ya había una config buena se sigue sirviendo (el secreto puede
            // estar rotándose); si no, null = fail-open hasta el próximo intento.
            logger.error?.(
                `[vq] sin config (secreto "${SECRET_NAME}"), ${entry.config ? "sirviendo la anterior" : "dejando pasar todo"}: ${err?.message || err}`,
            );
            entry = { config: entry.config, expire: now() + RETRY_MS };
        }

        return entry.config;
    }

    return async function getConfig() {
        if (now() < entry.expire) return entry.config;
        inflight ??= load().finally(() => { inflight = null; });
        return inflight;
    };
}
