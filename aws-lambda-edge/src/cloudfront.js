// Traducción entre el evento de CloudFront y el request normalizado del core.
//
// Forma de los headers en Lambda@Edge: claves en minúscula, y cada una es un
// ARRAY de {key, value} (un header puede repetirse). Es la fuente habitual de
// bugs al portar código de otros edges, así que todo el acceso pasa por acá.

export function headerValue(headers, name) {
    const entry = headers?.[name.toLowerCase()];
    return entry && entry.length > 0 ? entry[0].value : null;
}

// Los valores van percent-encoded (ver cookieHeader); se decodifican al leer.
// Un valor que no decodifica se devuelve crudo: puede ser una cookie ajena.
function decodeCookieValue(raw) {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

// CloudFront puede entregar el Cookie en varias entradas; hay que concatenarlas
// todas o se pierden cookies.
export function parseCookies(headers) {
    const entries = headers?.cookie || [];
    const jar = {};

    for (const entry of entries) {
        for (const part of String(entry.value).split(";")) {
            const eq = part.indexOf("=");
            if (eq === -1) continue;
            const name = part.slice(0, eq).trim();
            if (!name || name in jar) continue; // gana la primera, como los browsers
            jar[name] = decodeCookieValue(part.slice(eq + 1).trim());
        }
    }

    return jar;
}

export function toRequest(cfRequest) {
    const upgrade = headerValue(cfRequest.headers, "upgrade");
    const fetchMode = headerValue(cfRequest.headers, "sec-fetch-mode");

    return {
        host: headerValue(cfRequest.headers, "host") || "",
        // Clave de dedupe del sensor (misma forma que el Worker: IP|User-Agent).
        // Nunca sale del contenedor: al TC viajan totales, no claves.
        clientKey: `${cfRequest.clientIp || ""}|${headerValue(cfRequest.headers, "user-agent") || ""}`,
        path: cfRequest.uri || "/",
        query: new URLSearchParams(cfRequest.querystring || ""),
        cookies: parseCookies(cfRequest.headers),
        method: cfRequest.method,
        isWebsocket: !!upgrade && upgrade.toLowerCase() === "websocket",
        // Sin el header (navegadores viejos, clientes HTTP) se trata como navegación.
        isNavigation: fetchMode ? fetchMode === "navigate" : undefined,
    };
}

export function cookieHeader({ name, value, maxAge }) {
    // El valor va percent-encoded: el destino guardado es un path con query y
    // un `;` adentro cortaría la cookie. Al pase (base64url) no lo altera.
    // Max-Age=0 borra la cookie. El pase es HttpOnly: ningún JS del sitio
    // necesita leerlo y así no queda expuesto a XSS.
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function redirectResponse(location, cookies = []) {
    const headers = {
        location: [{ key: "Location", value: location }],
        "cache-control": [{ key: "Cache-Control", value: "no-store" }],
    };

    if (cookies.length > 0) {
        headers["set-cookie"] = cookies.map((c) => ({ key: "Set-Cookie", value: cookieHeader(c) }));
    }

    return { status: "302", statusDescription: "Found", headers };
}
