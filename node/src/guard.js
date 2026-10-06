// SDK de Node: protección de cola dentro de la app del cliente.
//
// Es el equivalente server-side del JS adapter, y el equivalente "sin CDN" del
// conector de Lambda@Edge. Mismo core, mismas decisiones; solo cambia cómo entra
// y sale el request.
//
// Dos ventajas sobre Lambda@Edge, que vienen de correr en un server normal:
//   - Hay variables de entorno: la private_key no se hornea en ningún bundle.
//   - La renovación deslizante se resuelve en una sola pasada; Lambda@Edge
//     necesita una segunda función (viewer-response) para tocar la respuesta.

import { decide, validateConfig, buildLogger, sortRules, getSettings } from "@vqueue/connector-core";
import { parseCookies, serializeCookie, appendSetCookie } from "./cookies.js";

const DEFAULTS = {
    adminHost: "clients.virtual-queue.com",
    settingsTtlMs: 30_000,
    settingsTimeoutMs: 1_500,
    verifyTimeoutMs: 2_000,
    secureCookies: true,
    debug: false,
};

/**
 * Crea el guard.
 *
 * @param {object} options
 * @param {string} options.client      Subdominio de la compañía en VQueue.
 * @param {string} options.privateKey  private_key de la compañía (desde env, no hardcodeada).
 */
export function createQueueGuard(options = {}) {
    // Las opciones explícitas pisan los defaults; `client`/`privateKey` caen al
    // entorno solo si no vinieron (ni siquiera como undefined explícito).
    const config = { ...DEFAULTS, ...options };
    config.client = options.client ?? process.env.VQUEUE_CLIENT;
    config.privateKey = options.privateKey ?? process.env.VQUEUE_PRIVATE_KEY;

    const logger = options.logger ?? buildLogger(config);
    const check = validateConfig(config);

    if (!check.ok) {
        // No se encola a nadie con config incompleta: se avisa y se deja pasar.
        console.error(
            `[vqueue] conector mal configurado, dejando pasar todo: ${check.errors.join("; ")}`,
        );
    }

    async function decideFor(req) {
        if (!check.ok) return { type: "allow" };

        return decide(req, config, {
            logger,
            getSettings: () => getSettings(config, { sortRules, logger }),
            verifyTimeoutMs: config.verifyTimeoutMs,
        });
    }

    const cookieOptions = { secure: config.secureCookies };

    /**
     * Decide sin tocar la respuesta. Para frameworks raros o para testear.
     * Nunca lanza: ante cualquier error devuelve "allow".
     */
    async function check_(normalizedRequest) {
        try {
            return await decideFor(normalizedRequest);
        } catch (err) {
            logger.error?.(`[vqueue] error inesperado, fail-open: ${err?.stack || err}`);
            return { type: "allow" };
        }
    }

    /**
     * Aplica la decisión sobre un `http.ServerResponse`.
     * @returns {boolean} true si la respuesta ya se envió (no seguir la cadena).
     */
    function apply(decision, res) {
        if (decision.type === "redirect") {
            for (const cookie of decision.cookies ?? []) {
                appendSetCookie(res, serializeCookie(cookie, cookieOptions));
            }
            res.writeHead(302, { Location: decision.location, "Cache-Control": "no-store" });
            res.end();
            return true;
        }

        // Renovación deslizante: mientras el visitante navegue, el pase se
        // extiende. Sin esto el pase es un presupuesto fijo desde que salió
        // de la fila y una compra lenta vuelve a la cola a mitad de camino.
        if (decision.renew) {
            appendSetCookie(res, serializeCookie(decision.renew, cookieOptions));
        }

        return false;
    }

    // Traducir el request también puede fallar (una URL inválida): eso tampoco
    // debe tumbar el sitio. Express 4 no captura rechazos de middlewares async
    // y dejaría el request colgado.
    async function safeCheck(rawReq) {
        try {
            return await check_(fromNodeRequest(rawReq));
        } catch (err) {
            logger.error?.(`[vqueue] request no traducible, fail-open: ${err?.stack || err}`);
            return { type: "allow" };
        }
    }

    // Las funciones no dependen de `this`: se pueden desestructurar
    // (`const { express } = createQueueGuard(...)`) sin perder nada.
    return {
        config,
        check: check_,
        apply,

        /** Middleware de Express/Connect. */
        express() {
            return async (req, res, next) => {
                const decision = await safeCheck(req);
                if (!apply(decision, res)) next();
            };
        },

        /**
         * Hook `onRequest` de Fastify. Usa la API de `reply` y no el
         * ServerResponse crudo: un `Set-Cookie` puesto en `reply.raw` lo pisa
         * Fastify cuando la app setea el suyo (sesión), y perdería la renovación.
         */
        fastify() {
            return async (request, reply) => {
                const decision = await safeCheck(request.raw ?? request);

                if (decision.type === "redirect") {
                    for (const cookie of decision.cookies ?? []) {
                        reply.header("set-cookie", serializeCookie(cookie, cookieOptions));
                    }
                    reply.header("cache-control", "no-store");
                    reply.redirect(decision.location, 302);
                    return reply;
                }

                if (decision.renew) {
                    reply.header("set-cookie", serializeCookie(decision.renew, cookieOptions));
                }
            };
        },
    };
}

/**
 * Traduce un `http.IncomingMessage` al request normalizado del core.
 * Sirve para Express, Fastify (`request.raw`) y `http` pelado.
 */
export function fromNodeRequest(req) {
    // `req.url` es solo path+query; el host viene por header.
    const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
    const url = new URL(req.url || "/", `https://${host || "placeholder.invalid"}`);
    const upgrade = req.headers?.upgrade;

    return {
        host: String(host).split(":")[0].toLowerCase(),
        path: url.pathname,
        query: url.searchParams,
        cookies: parseCookies(req.headers?.cookie),
        method: req.method || "GET",
        isWebsocket: !!upgrade && String(upgrade).toLowerCase() === "websocket",
    };
}
