// Sensor de carga: activación automática contra el TC (traffic counter).
//
// Es el equivalente del par "batching por isolate + DO RateLimiter" del Worker
// de VQueue, para entornos sin Durable Objects: un contenedor Lambda@Edge, un
// proceso Node. El proceso ve una fracción del tráfico, así que NO decide nada:
// cuenta llegadas, las manda en lotes al TC y aplica el estado que el TC
// devuelve. Es el modelo de Queue-it v5 ("Direct Pass"): la decisión vive en el
// backend; el edge solo aplica un flag.
//
// Por proceso y por evento:
//   - cuenta `n` (llegadas, dedupe por clientKey en una ventana de 2 s) y `u`
//     (clientes distintos dentro de buy_time, para la Ley de Little);
//   - como mucho una vez por `tickMs` (1 s), en la MISMA invocación del request
//     que cruza el tick, manda una línea `v1` a POST /v1/ingest y toma
//     `event_state` de la respuesta. Hasta el próximo tick nadie toca la red.
//
// El TC recibe O(procesos) líneas por segundo, no O(visitantes), y nunca ve
// paths, IPs ni cookies: solo totales.
//
// En Lambda@Edge no hay trabajo en background: un contenedor se congela al
// devolver la respuesta. Por eso el tick se espera (con timeout corto) dentro
// del request que lo dispara: un request por segundo por contenedor paga hasta
// `timeoutMs` de latencia extra; el resto no toca red.
//
// Política de fallos:
//   - TC inalcanzable / timeout / no-2xx → se mantiene el último estado conocido
//     mientras tenga menos de `staleMs`; sin ninguno, "unknown" y el visitante
//     PASA (fail-open, como el Worker cuando el DO no contesta).
//   - El TC respondió pero sin nuestro evento (`null`): todavía no corrió su
//     primer tick → sin cambio de estado.
//   - El TC rechazó la línea por token desconocido (`rejected.unknown_token`): el
//     token está mal cargado. Se loguea fuerte y el evento se trata como
//     "active" (encola siempre, la misma protección que sin sensor), NO como
//     fail-open: un token mal pegado no puede apagar la protección en silencio.
//   - Si el POST falla, los totales se suman al próximo lote (acotado).
//
// Formato de la línea (docs/tc.md en vqueue_workers; mismo orden que el Worker):
//   v1 <token> <event_id> <n> <u> <th> <max_load> <tolerance> <buy_time> <ts_ms>

import { Deduper } from "./dedupe.js";

export const DEFAULT_TC_URL = "https://tc.virtual-queue.com";
export const DEFAULT_TICK_MS = 1_000;
export const DEFAULT_TIMEOUT_MS = 800;
// Cuánto vale un estado conocido cuando el TC no contesta.
export const DEFAULT_STALE_MS = 60_000;
// Ventana del dedupe de llegadas (la del EMA en el Worker: RATE_DEDUPE_MS).
export const RATE_DEDUPE_MS = 2_000;
// Ventana de clientes distintos cuando la regla no trae buy_time.
export const DEFAULT_UNIQUE_WINDOW_MS = 600_000;
// Tolerancia por defecto, la misma que usa el Worker al armar la línea.
export const DEFAULT_TOLERANCE = 0.8;
const MAX_DEDUPE_KEYS = 50_000;
const MAX_EVENTS = 200;
// Si el POST falla repetidamente, no acumulamos sin tope.
const MAX_CARRY = 1_000_000;
// El error de token se repite en cada tick: una línea por minuto alcanza.
const TOKEN_ERROR_LOG_MS = 60_000;

function unreplaced(value) {
    return typeof value === "string" && value.startsWith("__VQ_") && value.endsWith("__");
}

// El token configurado, o null si no hay (placeholder del bundle incluido).
export function tcTokenOf(config) {
    const token = config?.tcToken;
    if (typeof token !== "string" || token.trim() === "" || unreplaced(token)) return null;
    return token.trim();
}

// La URL base del TC sin barra final, o null si no es http(s).
export function tcUrlOf(config) {
    const raw = typeof config?.tcUrl === "string" && config.tcUrl.trim() !== "" ? config.tcUrl.trim() : DEFAULT_TC_URL;
    if (!/^https?:\/\//i.test(raw)) return null;
    return raw.replace(/\/+$/, "");
}

function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Arma la línea `v1` con los valores que el TC acepta (ver `TC.Line`):
 * th y max_load >= 0, tolerance en [0,1], buy_time entero >= 0, u <= n.
 */
export function buildTcLine(token, eventId, n, u, params = {}, tsMs = Date.now()) {
    const arrivals = Math.max(0, Math.floor(Number(n) || 0));
    const uniques = Math.min(arrivals, Math.max(0, Math.floor(Number(u) || 0)));
    const th = nonNegative(params.threshold);
    const maxLoad = nonNegative(params.maxLoad);
    const tol = params.tolerance == null || params.tolerance === "" ? NaN : Number(params.tolerance);
    const tolerance = Number.isFinite(tol) && tol >= 0 && tol <= 1 ? tol : DEFAULT_TOLERANCE;
    const buyTime = Math.round(nonNegative(params.buyTime));
    return `v1 ${token} ${eventId} ${arrivals} ${uniques} ${th} ${maxLoad} ${tolerance} ${buyTime} ${Math.floor(tsMs)}\n`;
}

function uniqueWindowMs(params) {
    const buyTimeMs = nonNegative(params?.buyTime) * 1000;
    return buyTimeMs > 0 ? Math.max(buyTimeMs, RATE_DEDUPE_MS) : DEFAULT_UNIQUE_WINDOW_MS;
}

/**
 * Crea el sensor para una config. Devuelve null si no hay `tcToken`: el
 * conector sigue como siempre (una regla automática encola siempre).
 *
 * @param {object} config  tcToken, tcUrl?, tcTickMs?, tcTimeoutMs?, tcStaleMs?
 * @param {object} deps    fetchImpl?, now?, logger?
 */
export function createSensor(config, { fetchImpl = fetch, now = Date.now, logger } = {}) {
    const token = tcTokenOf(config);
    if (!token) return null;
    const baseUrl = tcUrlOf(config);
    if (!baseUrl) {
        logger?.error?.(`[tc] tcUrl inválida (${config?.tcUrl}): el sensor queda deshabilitado`);
        return null;
    }
    const ingestUrl = `${baseUrl}/v1/ingest`;

    const tickMs = positive(config.tcTickMs, DEFAULT_TICK_MS);
    const timeoutMs = positive(config.tcTimeoutMs, DEFAULT_TIMEOUT_MS);
    const staleMs = positive(config.tcStaleMs, DEFAULT_STALE_MS);

    const events = new Map(); // eventId -> entry

    function entryFor(eventId, params) {
        let entry = events.get(eventId);
        if (!entry) {
            if (events.size >= MAX_EVENTS) events.clear();
            entry = {
                n: 0,
                u: 0,
                params: params || {},
                rateDedupe: new Deduper(RATE_DEDUPE_MS, MAX_DEDUPE_KEYS),
                uniqueDedupe: new Deduper(uniqueWindowMs(params), MAX_DEDUPE_KEYS),
                state: null,
                stateAt: 0,
                nextTickAt: 0,
                inflight: null,
                tokenErrorAt: 0,
            };
            events.set(eventId, entry);
        } else if (params) {
            // La regla puede cambiar (buy_time, umbrales) entre refrescos de settings.
            entry.params = params;
            const window = uniqueWindowMs(params);
            if (entry.uniqueDedupe.windowMs !== window) entry.uniqueDedupe.windowMs = window;
        }
        return entry;
    }

    function currentState(entry, t) {
        if (entry.state && t - entry.stateAt < staleMs) return entry.state;
        return "unknown";
    }

    function applyReply(eventId, entry, body) {
        const rejected = body?.rejected;
        if (rejected && Number(rejected.unknown_token) > 0) {
            entry.state = "active";
            entry.stateAt = now();
            if (now() - entry.tokenErrorAt >= TOKEN_ERROR_LOG_MS) {
                entry.tokenErrorAt = now();
                logger?.error?.(`[tc] el TC no reconoce el tcToken: el evento ${eventId} encola siempre. Revisá el token del traffic counter en la config.`);
            }
            return;
        }
        if (rejected && typeof rejected === "object" && Object.keys(rejected).length > 0) {
            logger?.warn?.(`[tc] línea rechazada para ${eventId}: ${JSON.stringify(rejected)}`);
        }
        const data = body?.data?.[eventId];
        if (data && (data.event_state === "active" || data.event_state === "inactive")) {
            entry.state = data.event_state;
            entry.stateAt = now();
        }
        // `null`: el TC todavía no corrió su primer tick para este evento.
    }

    async function tick(eventId, entry, t0) {
        entry.nextTickAt = t0 + tickMs;
        const n = entry.n;
        const u = entry.u;
        entry.n = 0;
        entry.u = 0;

        // Se manda aunque n sea 0: la respuesta refresca el estado.
        const line = buildTcLine(token, eventId, n, u, entry.params, t0);

        let resp;
        try {
            resp = await fetchImpl(ingestUrl, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: line,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!resp.ok) throw new Error(`status ${resp.status}`);
        } catch (err) {
            // Lo no entregado se suma al próximo lote, con tope.
            entry.n = Math.min(MAX_CARRY, entry.n + n);
            entry.u = Math.min(entry.n, entry.u + u);
            logger?.warn?.(`[tc] ingest falló para ${eventId}: ${err?.message || err}`);
            return currentState(entry, now());
        }

        let body;
        try {
            body = await resp.json();
        } catch (err) {
            logger?.warn?.(`[tc] respuesta inválida para ${eventId}: ${err?.message || err}`);
            return currentState(entry, now());
        }

        applyReply(eventId, entry, body);
        return currentState(entry, now());
    }

    return {
        /**
         * Registra una llegada al evento y devuelve el estado a aplicar:
         * "active" (encolar), "inactive" (pasa, Direct Pass) o "unknown" (pasa:
         * fail-open). `params` son los umbrales de la regla
         * ({threshold, maxLoad, tolerance, buyTime}). Nunca lanza.
         */
        async observe(eventId, clientKey, params) {
            const entry = entryFor(eventId, params);
            const t = now();

            if (!entry.rateDedupe.seen(clientKey, t)) entry.n++;
            if (!entry.uniqueDedupe.seen(clientKey, t)) entry.u++;

            if (t < entry.nextTickAt) return currentState(entry, t);
            if (entry.inflight) return entry.inflight;

            const run = tick(eventId, entry, t)
                .catch((err) => {
                    logger?.warn?.(`[tc] tick falló para ${eventId}: ${err?.message || err}`);
                    return currentState(entry, now());
                })
                .finally(() => { if (entry.inflight === run) entry.inflight = null; });
            entry.inflight = run;
            return run;
        },

        // Solo para tests y diagnóstico.
        _entry(eventId) {
            return events.get(eventId) || null;
        },
    };
}
