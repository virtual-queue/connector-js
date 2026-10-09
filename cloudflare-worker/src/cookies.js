// Cookies del Worker. Mismo formato que el conector de AWS: el valor va
// percent-encoded (el destino guardado es un path con query, y un `;` adentro
// cortaría la cookie) y el pase es HttpOnly, así que ningún JS del sitio lo lee.

function decodeCookieValue(raw) {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw; // puede ser una cookie ajena que no es percent-encoded
    }
}

export function parseCookies(header) {
    const jar = {};
    for (const part of String(header || "").split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        if (!name || name in jar) continue; // gana la primera, como los browsers
        jar[name] = decodeCookieValue(part.slice(eq + 1).trim());
    }
    return jar;
}

export function cookieHeader({ name, value, maxAge }) {
    // Max-Age=0 borra la cookie.
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
