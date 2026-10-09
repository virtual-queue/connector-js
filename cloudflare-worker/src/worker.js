// Cloudflare Worker — conector de VirtualQueue.
//
// Corre en CADA request de las rutas donde lo asocies. Decide si el visitante
// pasa, si vuelve de la cola con un token para canjear, o si va a la sala de
// espera. A diferencia de Lambda@Edge, un Worker ve la respuesta del origin, así
// que la renovación deslizante del pase se hace acá mismo, sin segunda función.
//
// Solo protección MANUAL: aplica las reglas de acceso; no mide tráfico.
// Todo falla abierto: sin config, sin API o con un error cualquiera, el visitante
// pasa. Un conector que rompe el sitio del cliente es peor que uno que no encola.

import { sortRules } from "../vendor/acl.js";
import { buildLogger, validateConfig } from "../vendor/config.js";
import { decide } from "../vendor/decide.js";
import { getSettings } from "../vendor/settings.js";
import { cookieHeader, parseCookies } from "./cookies.js";

const DEFAULT_ADMIN_HOST = "clients.virtual-queue.com";
const PLACEHOLDER_CLIENT = "your-subdomain";

// Presupuesto total de la decisión. Las llamadas internas ya tienen su timeout
// (settings 1.5 s, verify 2 s); esto acota el peor caso de ambas juntas.
const DEADLINE_MS = 3_500;

// Los settings son públicos y cacheables (`public, max-age=30, s-maxage=60`).
// Pedirle a Cloudflare que los guarde 30 s evita que cada isolate de cada
// ubicación golpee al admin: el cache en memoria del core vive solo en un isolate.
const settingsFetch = (url, init) => fetch(url, { ...init, cf: { cacheTtl: 30, cacheEverything: true } });

export function readConfig(env) {
    const config = {
        client: env?.CLIENT,
        privateKey: env?.PRIVATE_KEY,
        adminHost: env?.ADMIN_HOST || DEFAULT_ADMIN_HOST,
        debug: env?.DEBUG === "true",
    };

    const { ok, errors } = validateConfig(config);
    if (config.client === PLACEHOLDER_CLIENT) {
        errors.push("`CLIENT` sin configurar (subdominio de la compañía en VQueue)");
    }
    return { config, errors: ok && config.client !== PLACEHOLDER_CLIENT ? [] : errors };
}

function toRequest(request, url) {
    const upgrade = request.headers.get("upgrade");
    return {
        host: url.host,
        path: url.pathname,
        query: url.searchParams,
        cookies: parseCookies(request.headers.get("cookie")),
        method: request.method,
        isWebsocket: !!upgrade && upgrade.toLowerCase() === "websocket",
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

async function decideWithDeadline(req, config, logger) {
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
            logger.warn?.(`[vq] se agotó el presupuesto de ${DEADLINE_MS}ms, fail-open`);
            resolve({ type: "allow" });
        }, DEADLINE_MS);
    });

    try {
        return await Promise.race([
            decide(req, config, {
                logger,
                getSettings: () => getSettings(config, { sortRules, logger, fetchImpl: settingsFetch }),
            }),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export default {
    async fetch(request, env) {
        const logger = buildLogger({ debug: env?.DEBUG === "true" });
        let decision = { type: "allow" };

        // Solo la DECISIÓN va en el try: si el origin falla, ese error es del
        // origin y no se reintenta (el cuerpo del request ya se consumió).
        try {
            const { config, errors } = readConfig(env);
            if (errors.length > 0) {
                logger.error?.(`[vq] config inválida, fail-open: ${errors.join("; ")}`);
            } else {
                const url = new URL(request.url);
                decision = await decideWithDeadline(toRequest(request, url), config, logger);
            }
        } catch (err) {
            // Red de seguridad final: cualquier excepción deja pasar al visitante.
            console.error(`[vq] error inesperado, fail-open: ${err?.stack || err}`);
            decision = { type: "allow" };
        }

        if (decision.type === "redirect") {
            return redirectResponse(decision.location, decision.cookies, request.url);
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
