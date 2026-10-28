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

import { phase } from "./timing.js";

const DEFAULT_TTL_MS = 30_000;
// Vida de una entrada servida en modo degradado tras un fallo: corta, para
// reintentar pronto, pero suficiente para no castigar cada request.
const STALE_TTL_MS = 5_000;
// Hasta qué edad una copia vencida se sirve sin esperar al refresco.
const MAX_STALE_MS = 300_000;
// La primera llamada de red de un contenedor Lambda@Edge frío a 128 MB tarda
// 1.5-2 s (medido: 1.7 s). Con 1500 ese fetch se abortaba y el primer visitante,
// y los 5 s de negative cache que siguen, pasaban sin protección. Con 3000 el
// fetch frío termina; el deadline de 4 s del handler sigue evitando el 503.
const DEFAULT_TIMEOUT_MS = 3_000;

// Mismos límites que el Worker (`resolveCookieTtl`) y el JS adapter: un valor
// inválido o no positivo cae al default, y nada supera las 24h.
export const DEFAULT_COOKIE_LIFETIME = 600;
export const MAX_COOKIE_LIFETIME = 86_400;

// Estado por contenedor, UNA entrada por endpoint de settings. Un proceso Node
// puede alojar más de un guard (dos clientes, dos admins): con un único slot
// global, el segundo guard leería los settings del primero.
const cache = new Map(); // settingsUrl -> { settings, loadedAt, expire, inflight, inflightAt, gen, blockNext }

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
        entry = { settings: null, loadedAt: 0, expire: 0, inflight: null, inflightAt: 0, gen: 0, blockNext: false };
        cache.set(url, entry);
    }

    // `expire` también acota el backoff tras un fallo: con settings en null,
    // devolver null sin ir a la red es la negative cache.
    const t = now();
    if (t < entry.expire) return entry.settings;

    // Stale-while-revalidate: con una copia vencida pero no rancia, se sirve esa
    // al toque y el refresco corre aparte. Sin esto, un request cada `ttl` por
    // proceso pagaba el round trip completo (300-1500 ms medidos en Lambda@Edge).
    // Pasada la ventana rancia se vuelve a bloquear: una config de hace cinco
    // minutos ya no es "un poco vieja".
    const stale = entry.settings && t - entry.loadedAt < MAX_STALE_MS;
    const ttl = Number(config.settingsTtlMs) || DEFAULT_TTL_MS;
    const timeout = Number(config.settingsTimeoutMs) || DEFAULT_TIMEOUT_MS;

    // Un refresco en vuelo hace más que el timeout quedó congelado con el
    // contenedor (Lambda@Edge): su timer cuenta tiempo de pared, así que al
    // descongelarse se aborta solo. Se lo abandona y este request trae la config
    // esperando, porque otro refresco de fondo se congelaría igual.
    let blocking = !stale || entry.blockNext;
    if (entry.inflight) {
        if (t - entry.inflightAt < timeout) return stale ? entry.settings : entry.inflight;
        entry.gen++;
        entry.inflight = null;
        blocking = true;
    }
    const gen = entry.gen;
    const current = () => entry.gen === gen;

    // Solo se mide el refresco real: un hit de cache no llega hasta acá, y esa
    // ausencia de línea ya dice que el contenedor venía tibio.
    const done = phase(logger, "settings");

    // Ante un fallo servimos la última config buena aunque esté vencida: es
    // preferible a dejar el origen sin protección por un hipo de red. Y se
    // cachea el fallo unos segundos: sin eso, cada request pagaría el timeout.
    //
    // Un refresco de fondo que falla no cachea el fallo: marca que el próximo
    // request espere. Si no, un refresco congelado y abortado al descongelar
    // dejaría 5 s de copia vieja, el siguiente se congelaría igual, y con tráfico
    // espaciado la config no se refrescaría hasta volverse rancia. Tampoco se
    // avisa con warn: en Lambda@Edge es lo normal tras cada TTL con tráfico
    // espaciado, y una caída real igual avisa en el fetch que espera.
    const degrade = (reason) => {
        if (!current()) return entry.settings;
        done(reason);
        if (blocking) {
            logger?.warn?.(`[settings] ${reason}`);
            entry.blockNext = false;
            entry.expire = now() + STALE_TTL_MS;
        } else {
            logger?.log?.(`[settings] background refresh: ${reason}`);
            entry.blockNext = true;
        }
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
        if (!current()) return settings;

        done("ok");
        entry.settings = settings;
        entry.loadedAt = now();
        entry.expire = entry.loadedAt + ttl;
        entry.blockNext = false;
        logger?.log?.(`[settings] loaded ${settings.rules.length} rules`);
        return settings;
    })();

    // El refresco se desengancha solo: con stale-while-revalidate puede no haber
    // nadie esperándolo. `load` nunca rechaza (todo fallo pasa por `degrade`).
    entry.inflightAt = t;
    entry.inflight = load.finally(() => {
        if (current()) entry.inflight = null;
    });

    // En Node y en el Worker el refresco de fondo termina solo. En Lambda@Edge
    // termina solo si el siguiente request llega antes del timeout; si no, ese
    // request lo abandona y espera uno nuevo (ver arriba).
    if (!blocking) return entry.settings;
    return entry.inflight;
}
