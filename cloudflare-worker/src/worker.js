// Cloudflare Worker — conector de VirtualQueue.
//
// Corre en CADA request de las rutas donde lo asocies. Decide si el visitante
// pasa, si vuelve de la cola con un token para canjear, o si va a la sala de
// espera. A diferencia de Lambda@Edge, un Worker ve la respuesta del origin, así
// que la renovación deslizante del pase se hace acá mismo, sin segunda función.
//
// Activación automática: con TC_TOKEN, las reglas con umbrales cuentan llegadas
// por isolate y, una vez por segundo, el request que cruza el tick manda los
// totales al TC y toma el estado del evento (ver vendor/tc.js). Sin TC_TOKEN no
// hay sensor y esas reglas encolan siempre (el core avisa en los logs).
// Todo falla abierto: sin config, sin API o con un error cualquiera, el visitante
// pasa. Un conector que rompe el sitio del cliente es peor que uno que no encola.

import { sortRules } from "../vendor/acl.js";
import { buildLogger, validateConfig } from "../vendor/config.js";
import { logPhase } from "../vendor/timing.js";
import { decide } from "../vendor/decide.js";
import { getSettings } from "../vendor/settings.js";
import { createSensor } from "../vendor/tc.js";
import { cookieHeader, parseCookies } from "./cookies.js";

const DEFAULT_ADMIN_HOST = "clients.virtual-queue.com";

// Valor de ejemplo de .dev.vars.example: cuenta como "sin token".
const EXAMPLE_TC_TOKEN = "your-tc-token";

// Presupuesto total de la decisión. Las llamadas internas ya tienen su timeout
// (settings 3 s, verify 2 s, sensor 0.8 s); esto acota el peor caso. Lo que
// queda en vuelo al vencer sigue en `ctx.waitUntil` y llena los caches.
const DEADLINE_MS = 3_500;

// Los settings son públicos y cacheables (`public, max-age=30, s-maxage=60`).
// Se pide cachear solo las respuestas buenas: un error no se guarda. Si el admin
// está en otra zona de Cloudflare, puede que esta preferencia no aplique (la
// subrequest lee el cache de esa zona); el cache por isolate del core sí aplica.
const settingsFetch = (url, init) =>
    fetch(url, { ...init, cf: { cacheTtlByStatus: { "200-299": 30, "300-599": 0 } } });

const isDebug = (env) => env?.DEBUG === true || env?.DEBUG === "true";

// Una config inválida se avisa una vez por isolate, no en cada request: durante
// un pico serían millones de líneas de log (y de facturación de logs).
let configErrorLogged = false;

export function readConfig(env) {
    const tcToken = typeof env?.TC_TOKEN === "string" ? env.TC_TOKEN.trim() : "";
    const config = {
        client: typeof env?.CLIENT === "string" ? env.CLIENT.trim() : env?.CLIENT,
        privateKey: env?.PRIVATE_KEY,
        adminHost: env?.ADMIN_HOST || DEFAULT_ADMIN_HOST,
        // Opcionales: sin tcToken no hay sensor (tc.js usa su URL por defecto).
        tcToken: tcToken === EXAMPLE_TC_TOKEN ? "" : tcToken,
        ...(env?.TC_URL ? { tcUrl: env.TC_URL } : {}),
        debug: isDebug(env),
    };

    // validateConfig rechaza vacíos y los valores de ejemplo de .dev.vars.example.
    // El tcToken no se valida: un token mal cargado no apaga el conector.
    const { errors } = validateConfig(config);
    return { config, errors };
}

// El sensor vive con el isolate (sus contadores y el estado cacheado). La config
// se relee en cada request, así que se rearma solo si cambia lo que lo define.
let sensor = null;
let sensorKey = null;
function sensorFor(config, logger) {
    const key = `${config.tcToken}|${config.tcUrl || ""}|${config.debug}`;
    if (key !== sensorKey) {
        // fetch se resuelve en cada llamada, no al crear el sensor.
        sensor = createSensor(config, { logger, fetchImpl: (url, init) => fetch(url, init) });
        sensorKey = key;
    }
    return sensor;
}

// Solo para tests.
export function _resetSensor() {
    sensor = null;
    sensorKey = null;
}

function toRequest(request, url) {
    const upgrade = request.headers.get("upgrade");
    const fetchMode = request.headers.get("sec-fetch-mode");
    return {
        host: url.host,
        clientKey: `${request.headers.get("cf-connecting-ip") || ""}|${request.headers.get("user-agent") || ""}`,
        path: url.pathname,
        query: url.searchParams,
        cookies: parseCookies(request.headers.get("cookie")),
        method: request.method,
        isWebsocket: !!upgrade && upgrade.toLowerCase() === "websocket",
        // Sin el header (navegadores viejos, clientes HTTP) se trata como navegación.
        isNavigation: fetchMode ? fetchMode === "navigate" : undefined,
    };
}

function redirectResponse(location, cookies, requestUrl) {
    const headers = new Headers({
        // La vuelta de la cola devuelve un path relativo; el Location va absoluto.
        Location: new URL(location, requestUrl).toString(),
        "Cache-Control": "no-store",
    });
    for (const c of cookies || []) headers.append("Set-Cookie", cookieHeader(c));
    return new Response(null, { status: 302, headers });
}

async function withRenewal(originResponse, renew) {
    const response = new Response(originResponse.body, originResponse);
    response.headers.append("Set-Cookie", cookieHeader(renew));
    return response;
}

async function decideWithDeadline(req, config, logger, ctx) {
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
            logger.warn?.(`[vq] se agotó el presupuesto de ${DEADLINE_MS}ms, fail-open`);
            resolve({ type: "allow" });
        }, DEADLINE_MS);
    });

    const decision = decide(req, config, {
        logger,
        getSettings: () => getSettings(config, { sortRules, logger, fetchImpl: settingsFetch }),
        sensor: sensorFor(config, logger),
    });
    // Si vence el presupuesto, el isolate cancelaría lo que quedó en vuelo al
    // responder. Sin esto, un tick del sensor cortado a mitad dejaría su
    // `inflight` sin resolver y los próximos requests esperándolo.
    ctx?.waitUntil?.(decision.catch(() => { }));

    try {
        return await Promise.race([decision, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

// Primera request de este isolate: el cache de settings vive por isolate, así
// que distingue "el conector tarda" de "el isolate estaba frío".
let coldStart = true;

export default {
    async fetch(request, env, ctx) {
        const startedAt = Date.now();
        const cold = coldStart;
        coldStart = false;
        // Si algo en este handler lanza una excepción no capturada, Cloudflare
        // manda el request al origin en vez de mostrar el error 1101.
        ctx?.passThroughOnException?.();

        const logger = buildLogger({ debug: isDebug(env) });
        let decision = { type: "allow" };

        // Solo la DECISIÓN va en el try: si el origin falla, ese error es del
        // origin y no se reintenta (el cuerpo del request ya se consumió).
        try {
            const { config, errors } = readConfig(env);
            if (errors.length > 0) {
                if (!configErrorLogged) {
                    configErrorLogged = true;
                    console.error(`[vq] config inválida, fail-open: ${errors.join("; ")}`);
                }
            } else {
                const url = new URL(request.url);
                decision = await decideWithDeadline(toRequest(request, url), config, logger, ctx);
            }
        } catch (err) {
            // Red de seguridad final: cualquier excepción deja pasar al visitante.
            console.error(`[vq] error inesperado, fail-open: ${err?.stack || err}`);
            decision = { type: "allow" };
        }

        // Antes de ir al origin: lo que sigue ya no es tiempo del conector.
        logPhase(logger, "request", Date.now() - startedAt, cold ? "cold" : "warm");

        if (decision.type === "redirect") {
            try {
                return redirectResponse(decision.location, decision.cookies, request.url);
            } catch (err) {
                console.error(`[vq] no se pudo armar el redirect, fail-open: ${err?.stack || err}`);
            }
        }

        const originResponse = await fetch(request);
        if (decision.type !== "allow" || !decision.renew) return originResponse;

        try {
            return await withRenewal(originResponse, decision.renew);
        } catch (err) {
            // Nunca romper la respuesta del origin por no poder renovar: en el
            // peor caso el pase vence antes y el visitante vuelve a la cola.
            console.error(`[vq] no se pudo renovar el pase: ${err?.stack || err}`);
            return originResponse;
        }
    },
};
