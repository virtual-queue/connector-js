// Verificación del pase de cola (QueuePass) emitido por VQueue.
//
// Formato, idéntico a VQueue.Lines.QueuePass (vqueue/lib/v_queue/lines/queue_pass.ex):
//
//   base64url(json_payload) "." base64url(hmac_sha256(private_key, base64url(json_payload)))
//
// Ambas partes SIN padding. Ojo con el detalle fácil de errar: lo que se firma
// es el payload YA codificado en base64url, no el JSON crudo.
//
// Payload:
//   t   - line id (el `token` que la cola agrega a la URL de vuelta)
//   e   - event id
//   iat - emisión, epoch segundos
//   exp - vencimiento, epoch segundos
//
// El secreto es el `private_key` de la compañía, así que esta verificación es
// OFFLINE: no hay que llamar a VQueue en cada request. Esa es toda la premisa
// del conector: el cliente lo instala en su AWS y valida por su cuenta.

import { createHmac, timingSafeEqual } from "node:crypto";

export const PASS_COOKIE_PREFIX = "vq_pass_";

// Nombre de la cookie del pase para un evento. Es POR EVENTO (igual que el JS
// adapter): un pase del evento A no admite al evento B.
export function passCookieName(eventId) {
    return `${PASS_COOKIE_PREFIX}${eventId}`;
}

function signatureFor(encodedPayload, secret) {
    return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

// Comparación en tiempo constante. timingSafeEqual exige buffers del mismo
// largo, así que la diferencia de longitud se responde antes (y esa sí se puede
// deducir del tamaño de la cookie, no es información nueva para un atacante).
function safeEqual(a, b) {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Verifica un pase.
 *
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 *   reason: "malformed" | "bad_signature" | "expired"
 */
export function verifyPass(pass, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (typeof pass !== "string" || typeof secret !== "string" || secret === "") {
        return { ok: false, reason: "malformed" };
    }

    const dot = pass.indexOf(".");
    if (dot <= 0 || dot === pass.length - 1) return { ok: false, reason: "malformed" };

    const encoded = pass.slice(0, dot);
    const sig = pass.slice(dot + 1);

    // Firma primero: no se decodifica nada que no esté autenticado.
    if (!safeEqual(signatureFor(encoded, secret), sig)) {
        return { ok: false, reason: "bad_signature" };
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
        return { ok: false, reason: "malformed" };
    }

    if (!payload || typeof payload !== "object" || !Number.isInteger(payload.exp)) {
        return { ok: false, reason: "malformed" };
    }

    if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };

    return { ok: true, payload };
}

/**
 * ¿Hay un pase válido para este evento entre las cookies del request?
 * Exige además que el `e` del payload sea el evento consultado: un pase de otro
 * evento, aunque esté bien firmado, no sirve.
 */
export function hasValidPassFor(cookies, eventId, secret, nowSeconds) {
    const raw = cookies[passCookieName(eventId)];
    if (!raw) return { ok: false, reason: "absent" };

    const result = verifyPass(raw, secret, nowSeconds);
    if (!result.ok) return result;

    if (String(result.payload.e) !== String(eventId)) {
        return { ok: false, reason: "event_mismatch" };
    }

    return result;
}
