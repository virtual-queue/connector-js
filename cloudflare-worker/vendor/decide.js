// Núcleo de decisión del conector. No sabe nada de AWS ni de CloudFront: recibe
// un request normalizado y devuelve qué hacer. Los adaptadores (viewer-request /
// viewer-response, o un ALB más adelante) solo traducen formatos.
//
// Regla transversal: TODO falla abierto. Si no se pueden traer los settings, si
// la API de verify no responde, si el pase está roto — el visitante pasa. Un
// conector que rompe el sitio del cliente es peor que uno que no encola.

import { ASSET_REGEX, findMatch } from "./acl.js";
import { hasValidPassFor, passCookieName } from "./pass.js";

export const TARGET_COOKIE_PREFIX = "vq_target_";
// El destino se guarda solo para cruzar la ida a la cola; no necesita durar más.
const TARGET_TTL_SECONDS = 3600;

// El token de la cola es el id de la línea: un UUID. Mismo filtro que el JS
// adapter. Sin él, cada `?token=` propio del sitio (reset de password, magic
// link) costaría un round trip a /queue/verify por página, y cualquiera podría
// hacer que el server del cliente golpee la API de VQueue a voluntad.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function targetCookieName(eventId) {
    return `${TARGET_COOKIE_PREFIX}${eventId}`;
}

// Bypass barato: ni settings, ni red, ni verificación. Es además lo que mantiene
// acotado el costo, porque en Lambda@Edge se paga por invocación.
export function isBypassPath(path, method, isWebsocket) {
    if (isWebsocket) return true;
    if (method !== "GET" && method !== "HEAD") return true; // un 302 sobre POST pierde el body
    return path.startsWith("/api/") || ASSET_REGEX.test(path);
}

// Solo aceptamos un path absoluto propio. Nunca una URL completa: si dejáramos
// pasar "https://..." el conector se convertiría en un open redirect.
export function safeTarget(raw) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
    if (!raw.startsWith("/")) return null;
    // "//host" es una URL protocol-relative, y los browsers tratan "/\host"
    // exactamente igual.
    if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
    if (/[\r\n]/.test(raw)) return null;
    return raw;
}

export function queueToken(query) {
    const token = query.get("vq_token") || query.get("token");
    return token && UUID_RE.test(token) ? token : null;
}

function stripQueueToken(query) {
    const params = new URLSearchParams(query);
    params.delete("vq_token");
    params.delete("token");
    const rest = params.toString();
    return rest ? `?${rest}` : "";
}

/**
 * Canjea el token de la cola por un pase.
 * Devuelve `{eventId, pass}`, o null si no era un token de cola válido.
 */
export async function exchangeToken(token, settings, { logger, fetchImpl = fetch, verifyTimeoutMs = 2000 } = {}) {
    const url = `${settings.queueUrl.replace(/\/+$/, "")}/api/v1/queue/verify?token=${encodeURIComponent(token)}`;

    let resp;
    try {
        resp = await fetchImpl(url, {
            // Manual a propósito: /queue/verify es un endpoint JSON, un 3xx ahí es
            // un problema de routing. Siguiéndolo, un loop de CDN explota como
            // "too many redirects" y se lleva puesto todo el canje.
            redirect: "manual",
            signal: AbortSignal.timeout(verifyTimeoutMs),
            headers: { Accept: "application/json" },
        });
    } catch (err) {
        logger?.warn?.(`[verify] fetch failed: ${err?.message || err}`);
        return null;
    }

    if (resp.status >= 300 && resp.status < 400) {
        logger?.error?.(`[verify] redirect (routing mal configurado): ${resp.headers.get("location")}`);
        return null;
    }
    if (!resp.ok) {
        logger?.log?.(`[verify] rejected with status ${resp.status}`);
        return null;
    }

    let body;
    try {
        body = await resp.json();
    } catch (err) {
        logger?.warn?.(`[verify] invalid json: ${err?.message || err}`);
        return null;
    }

    const data = body?.data;
    if (!body?.success || !data?.event_id) {
        logger?.log?.(`[verify] not a queue token`);
        return null;
    }

    // Sin pase no hay nada que verificar offline. El JS adapter cae al token
    // crudo porque no puede verificar nada de todos modos; acá ese fallback solo
    // produciría una cookie que nunca valida y mandaría al visitante a la cola
    // en la página siguiente. Mejor tratarlo como canje fallido y avisar fuerte.
    if (typeof data.pass !== "string" || data.pass === "") {
        logger?.error?.(`[verify] VQueue no devolvió el pase para ${data.event_id}: fallo al firmar del lado de la cola`);
        return null;
    }

    return { eventId: String(data.event_id), pass: data.pass };
}

/**
 * Decide qué hacer con un request ya normalizado.
 *
 * @returns {{type:"bypass"}
 *         | {type:"allow", renew?: {name:string, value:string, maxAge:number}}
 *         | {type:"redirect", location:string, cookies:Array}}
 */
export async function decide(req, config, deps) {
    const { getSettings, logger } = deps;

    if (isBypassPath(req.path, req.method, req.isWebsocket)) {
        return { type: "bypass" };
    }

    const settings = await getSettings();
    if (!settings) {
        logger?.warn?.(`[decide] sin settings → fail-open`);
        return { type: "allow" };
    }

    //-----------------------------------------
    // 1) Vuelta de la cola con ?vq_token= (o el ?token= legacy)
    //-----------------------------------------
    const token = queueToken(req.query);
    if (token) {
        const exchanged = await exchangeToken(token, settings, deps);

        if (exchanged) {
            const cookies = [
                {
                    name: passCookieName(exchanged.eventId),
                    value: exchanged.pass,
                    maxAge: settings.cookieLifetime,
                },
                // El destino ya se consumió.
                { name: targetCookieName(exchanged.eventId), value: "", maxAge: 0 },
            ];

            // Volver a donde el visitante quería ir, no a donde la cola lo soltó.
            const stored = safeTarget(req.cookies[targetCookieName(exchanged.eventId)]);
            const location = stored || `${req.path}${stripQueueToken(req.query)}`;

            return { type: "redirect", location, cookies };
        }

        // No era un token de cola: seguimos al flujo normal de ACL. Así un
        // `?token=` propio del cliente (reset de password, magic link) no se
        // secuestra, y un token vencido no genera el loop cola→sitio→cola.
        logger?.log?.(`[decide] token no válido → sigue el flujo normal`);
    }

    //-----------------------------------------
    // 2) ACLs
    //-----------------------------------------
    const rule = findMatch(settings.rules, req.path);
    if (!rule) return { type: "allow" };
    if (rule.action === "bypass") return { type: "allow" };
    if (rule.action !== "redirect_to_queue") return { type: "allow" };

    if (!rule.event_id) {
        logger?.warn?.(`[decide] regla sin event_id → allow`);
        return { type: "allow" };
    }

    const eventId = String(rule.event_id);

    //-----------------------------------------
    // 3) ¿Ya tiene pase para este evento?
    //-----------------------------------------
    const pass = hasValidPassFor(req.cookies, eventId, config.privateKey);
    if (pass.ok) {
        // Renovación deslizante: mientras el visitante siga navegando, el pase se
        // extiende. Sin esto es un presupuesto fijo desde que salió de la fila y
        // cualquier compra más lenta que el promedio vuelve a la cola.
        return {
            type: "allow",
            renew: {
                name: passCookieName(eventId),
                value: req.cookies[passCookieName(eventId)],
                maxAge: settings.cookieLifetime,
            },
        };
    }

    logger?.log?.(`[decide] sin pase para ${eventId} (${pass.reason}) → cola`);

    //-----------------------------------------
    // 4) A la sala de espera
    //-----------------------------------------
    const target = `${req.path}${req.query.toString() ? `?${req.query}` : ""}`;
    return {
        type: "redirect",
        location: `${settings.queueUrl.replace(/\/+$/, "")}/queue/${encodeURIComponent(eventId)}`,
        cookies: [
            { name: targetCookieName(eventId), value: target, maxAge: TARGET_TTL_SECONDS },
        ],
    };
}
