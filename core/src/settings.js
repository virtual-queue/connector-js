// Settings del cliente: ACLs + URL de la cola.
//
// Endpoint PÚBLICO y sin autenticar: GET /api/v1/adapter/:client/settings
// Es el mismo que consume el JS adapter desde el browser. Se usa este y NO
// /api/v1/edge/config/:domain a propósito: ese segundo es interno y requiere un
// token de plataforma que no se le entrega a un cliente para que lo instale en
// su AWS.
//
// Cache en memoria del contenedor Lambda: sobrevive entre invocaciones del mismo
// contenedor tibio, igual que el cache por isolate del Worker. No hace falta nada
// compartido (DynamoDB/S3) porque el endpoint ya es cacheable por CDN
// (`public, max-age=30, s-maxage=60`) y las ACLs cambian poco.

const DEFAULT_TTL_MS = 30_000;
// Vida de una entrada servida en modo degradado tras un fallo: corta, para
// reintentar pronto, pero suficiente para no castigar cada request.
const STALE_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 1_500;

// Mismos límites que el Worker (`resolveCookieTtl`) y el JS adapter: un valor
// inválido o no positivo cae al default, y nada supera las 24h.
export const DEFAULT_COOKIE_LIFETIME = 600;
export const MAX_COOKIE_LIFETIME = 86_400;

// Estado por contenedor, UNA entrada por endpoint de settings. Un proceso Node
// puede alojar más de un guard (dos clientes, dos admins): con un único slot
// global, el segundo guard leería los settings del primero.
const cache = new Map(); // settingsUrl -> { settings, expire, inflight }

// Solo para tests.
export function _resetSettingsCache() {
    cache.clear();
}

export function settingsUrl(config) {
    const host = config.adminHost || "clients.virtual-queue.com";
    return `https://${host}/api/v1/adapter/${encodeURIComponent(config.client)}/settings`;
}

export function resolveCookieLifetime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOKIE_LIFETIME;
    return Math.min(Math.floor(n), MAX_COOKIE_LIFETIME);
}

// Normaliza una vez por refresco: ordenar reglas por request sería trabajo
// repetido en el camino caliente. Devuelve null si el payload no sirve.
function normalize(data, sortRules) {
    if (!data || !Array.isArray(data.acls)) return null;
    // Sin queue_url no hay a dónde mandar a nadie: mejor "sin settings" (y
    // fail-open explícito) que un redirect a "undefined/queue/...".
    if (typeof data.queue_url !== "string" || !/^https?:\/\//i.test(data.queue_url)) return null;

    return {
        client: data.client,
        queueUrl: data.queue_url,
        cookieLifetime: resolveCookieLifetime(data.cookie_lifetime),
        rules: sortRules(data.acls),
    };
}

/**
 * Devuelve los settings (cacheados) o null si no hay forma de obtenerlos.
 * Nunca lanza: todo fallo termina en fail-open.
 */
export async function getSettings(config, { sortRules, logger, now = Date.now, fetchImpl = fetch } = {}) {
    const url = settingsUrl(config);
    let entry = cache.get(url);
    if (!entry) {
        entry = { settings: null, expire: 0, inflight: null };
        cache.set(url, entry);
    }

    // `expire` también acota el backoff tras un fallo: con settings en null,
    // devolver null sin ir a la red es la negative cache.
    if (now() < entry.expire) return entry.settings;
    if (entry.inflight) return entry.inflight;

    const ttl = Number(config.settingsTtlMs) || DEFAULT_TTL_MS;
    const timeout = Number(config.settingsTimeoutMs) || DEFAULT_TIMEOUT_MS;

    // Ante un fallo servimos la última config buena aunque esté vencida: es
    // preferible a dejar el origen sin protección por un hipo de red. Y se
    // cachea el fallo unos segundos: sin eso, cada request pagaría el timeout.
    const degrade = (reason) => {
        logger?.warn?.(`[settings] ${reason}`);
        entry.expire = now() + STALE_TTL_MS;
        return entry.settings;
    };

    const load = (async () => {
        let resp;
        try {
            resp = await fetchImpl(url, {
                signal: AbortSignal.timeout(timeout),
                headers: { Accept: "application/json" },
            });
        } catch (err) {
            return degrade(`fetch failed: ${err?.message || err}`);
        }

        if (!resp.ok) return degrade(`status ${resp.status}`);

        let body;
        try {
            body = await resp.json();
        } catch (err) {
            return degrade(`invalid json: ${err?.message || err}`);
        }

        const settings = normalize(body?.data, sortRules);
        if (!settings) return degrade("unexpected body");

        entry.settings = settings;
        entry.expire = now() + ttl;
        logger?.log?.(`[settings] loaded ${settings.rules.length} rules`);
        return settings;
    })();

    entry.inflight = load;
    try {
        return await load;
    } finally {
        entry.inflight = null;
    }
}
