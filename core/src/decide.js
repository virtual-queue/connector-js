// Núcleo de decisión del conector. No sabe nada de AWS ni de CloudFront: recibe
// un request normalizado y devuelve qué hacer. Los adaptadores (viewer-request /
// viewer-response, o un ALB más adelante) solo traducen formatos.
//
// Regla transversal: TODO falla abierto. Si no se pueden traer los settings, si
// la API de verify no responde, si el pase está roto — el visitante pasa. Un
// conector que rompe el sitio del cliente es peor que uno que no encola.

import { ASSET_REGEX, findMatch } from "./acl.js";
import { hasValidPassFor, passCookieName, verifyPass } from "./pass.js";

export const TARGET_COOKIE_PREFIX = "vq_target_";
// El destino se guarda solo para cruzar la ida a la cola; no necesita durar más.
const TARGET_TTL_SECONDS = 3600;

// El token de la cola es el id de la línea: un UUID. Mismo filtro que el JS
// adapter. Sin él, cada `?token=` propio del sitio (reset de password, magic
// link) costaría un round trip a /queue/verify por página, y cualquiera podría
// hacer que el server del cliente golpee la API de VQueue a voluntad.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Si VQueue emite pases que NO validan con la privateKey configurada (clave mal
// cargada, placeholder sin cambiar, o rotada en el panel antes que acá), cada
// visitante entraría en un loop: cola → canje OK → cookie que no valida → cola.
// Eso es fail-closed. Cuando se detecta, se deja de encolar por un rato y se avisa
// fuerte en los logs. Estado por proceso/isolate, igual que el cache de settings.
const KEY_MISMATCH_TTL_MS = 5 * 60_000;
const keyMismatchUntil = new Map(); // privateKey -> epoch ms

function markKeyMismatch(privateKey) {
    keyMismatchUntil.set(privateKey, Date.now() + KEY_MISMATCH_TTL_MS);
}

function keyMismatchActive(privateKey) {
    const until = keyMismatchUntil.get(privateKey);
    if (!until) return false;
    if (Date.now() < until) return true;
    keyMismatchUntil.delete(privateKey);
    return false;
}

// Solo para tests.
export function _resetKeyMismatch() {
    keyMismatchUntil.clear();
}

// Path con el que se evalúan bypass y ACLs. Se decodifica (un origen decodifica
// "/%73hop" como "/shop", así que la regla tiene que verlo igual) y se sacan los
// parámetros de segmento (";jsessionid=...", que Tomcat/Spring ignoran): si no,
// "/checkout;x.css" pasaría como asset. El path ORIGINAL se usa para volver.
export function matchPath(path) {
    const withoutParams = String(path || "/").replace(/;[^/]*/g, "");
    try {
        return decodeURIComponent(withoutParams);
    } catch {
        return withoutParams;
    }
}

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
    if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
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
 * Devuelve `{eventId, pass}`, null si VQueue dijo que no es un token de cola
 * válido, o `{unavailable: true}` si no se pudo preguntar (red, timeout, 5xx,
 * redirect, respuesta ilegible). Esa diferencia decide entre seguir el flujo
 * normal y dejar pasar: un problema nuestro no puede devolver a la cola a
 * alguien que ya la hizo.
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
        return { unavailable: true };
    }

    if (resp.status >= 300 && resp.status < 400) {
        logger?.error?.(`[verify] redirect (routing mal configurado): ${resp.headers.get("location")}`);
        return { unavailable: true };
    }
    if (resp.status >= 500) {
        logger?.warn?.(`[verify] VQueue respondió ${resp.status}`);
        return { unavailable: true };
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
        return { unavailable: true };
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

    const path = matchPath(req.path);

    if (isBypassPath(path, req.method, req.isWebsocket)) {
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

        if (exchanged?.unavailable) {
            // Hizo la fila y no pudimos confirmarlo por un problema de red o de
            // VQueue: pasa. Mandarlo a la cola de nuevo le haría perder el lugar.
            logger?.warn?.(`[decide] verify no disponible → fail-open`);
            return { type: "allow" };
        }

        if (exchanged) {
            // Volver a donde el visitante quería ir, no a donde la cola lo soltó.
            // El fallback (el path actual) también pasa por safeTarget: sin eso,
            // "//evil.com?vq_token=..." redirigiría afuera.
            const stored = safeTarget(req.cookies[targetCookieName(exchanged.eventId)]);
            const location = stored || safeTarget(`${req.path}${stripQueueToken(req.query)}`) || "/";

            if (verifyPass(exchanged.pass, config.privateKey).reason === "bad_signature") {
                logger?.error?.(
                    `[decide] el pase de VQueue no valida con la privateKey configurada ` +
                    `(clave incorrecta, sin cambiar o rotada) → se deja de encolar por ${KEY_MISMATCH_TTL_MS / 60000} min`,
                );
                markKeyMismatch(config.privateKey);
                return {
                    type: "redirect",
                    location,
                    cookies: [{ name: targetCookieName(exchanged.eventId), value: "", maxAge: 0 }],
                };
            }

            const cookies = [
                {
                    name: passCookieName(exchanged.eventId),
                    value: exchanged.pass,
                    maxAge: settings.cookieLifetime,
                },
                // El destino ya se consumió.
                { name: targetCookieName(exchanged.eventId), value: "", maxAge: 0 },
            ];

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
    const rule = findMatch(settings.rules, path);
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

    if (keyMismatchActive(config.privateKey)) {
        logger?.warn?.(`[decide] privateKey no coincide con la de VQueue → fail-open (${eventId})`);
        return { type: "allow" };
    }

    logger?.log?.(`[decide] sin pase para ${eventId} (${pass.reason}) → cola`);

    //-----------------------------------------
    // 4) A la sala de espera
    //-----------------------------------------
    // El destino se guarda solo en navegaciones: un fetch/XHR a una ruta protegida
    // pisaría la página que el visitante pidió. Sin el header (navegadores viejos,
    // otros adaptadores) se asume navegación, que es el comportamiento anterior.
    const target = `${req.path}${req.query.toString() ? `?${req.query}` : ""}`;
    const cookies = req.isNavigation === false
        ? []
        : [{ name: targetCookieName(eventId), value: target, maxAge: TARGET_TTL_SECONDS }];
    return {
        type: "redirect",
        location: `${settings.queueUrl.replace(/\/+$/, "")}/queue/${encodeURIComponent(eventId)}`,
        cookies,
    };
}
