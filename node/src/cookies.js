// Cookies sobre el `http` de Node, sin depender de cookie-parser: el SDK se mete
// en la app de un cliente y no debe imponerle middlewares ni versiones.

// Los valores van percent-encoded (ver serializeCookie); se decodifican al
// leer. Un valor que no decodifica se devuelve crudo: puede ser una cookie ajena.
function decodeCookieValue(raw) {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export function parseCookies(cookieHeader) {
    const jar = {};
    if (!cookieHeader) return jar;

    for (const part of String(cookieHeader).split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        // Gana la primera, como hacen los browsers ante nombres repetidos.
        if (!name || name in jar) continue;
        jar[name] = decodeCookieValue(part.slice(eq + 1).trim());
    }

    return jar;
}

export function serializeCookie({ name, value, maxAge }, { secure = true } = {}) {
    // El valor va percent-encoded: el destino guardado es un path con query y
    // un `;` adentro cortaría la cookie. Al pase (base64url) no lo altera.
    // `secure` es configurable solo para que el SDK sea usable en desarrollo
    // sobre http://localhost; en producción va siempre en true.
    return [
        `${name}=${encodeURIComponent(value)}`,
        "Path=/",
        `Max-Age=${maxAge}`,
        "HttpOnly",
        secure ? "Secure" : null,
        "SameSite=Lax",
    ]
        .filter(Boolean)
        .join("; ");
}

// Agrega sin pisar: la app del cliente puede estar seteando sus propias cookies
// (sesión, CSRF) en la misma respuesta.
export function appendSetCookie(res, value) {
    const existing = res.getHeader("Set-Cookie");

    if (!existing) {
        res.setHeader("Set-Cookie", [value]);
        return;
    }

    res.setHeader("Set-Cookie", Array.isArray(existing) ? [...existing, value] : [existing, value]);
}
