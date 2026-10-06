// Traducción entre el evento de CloudFront y el request normalizado del core.
//
// Forma de los headers en Lambda@Edge: claves en minúscula, y cada una es un
// ARRAY de {key, value} (un header puede repetirse). Es la fuente habitual de
// bugs al portar código de otros edges, así que todo el acceso pasa por acá.

// Header interno con el que viewer-request le avisa a viewer-response que tiene
// que renovar el pase. Es la única forma de pasar estado entre las dos lambdas.
// Contrapartida: viaja al origin.
export const RENEW_HEADER = "x-vq-renew";

export function headerValue(headers, name) {
    const entry = headers?.[name.toLowerCase()];
    return entry && entry.length > 0 ? entry[0].value : null;
}

// El header interno es nuestro: lo que traiga el visitante se descarta antes de
// decidir nada. Si no, cualquiera podría pedirle a viewer-response que emita la
// cookie que quiera con solo mandar el header.
export function stripInternalHeaders(cfRequest) {
    if (cfRequest?.headers && RENEW_HEADER in cfRequest.headers) {
        delete cfRequest.headers[RENEW_HEADER];
    }
    return cfRequest;
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

    return {
        host: headerValue(cfRequest.headers, "host") || "",
        path: cfRequest.uri || "/",
        query: new URLSearchParams(cfRequest.querystring || ""),
        cookies: parseCookies(cfRequest.headers),
        method: cfRequest.method,
        isWebsocket: !!upgrade && upgrade.toLowerCase() === "websocket",
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

// Marca el request para que viewer-response renueve el pase.
export function markForRenewal(cfRequest, renew) {
    cfRequest.headers[RENEW_HEADER] = [
        { key: RENEW_HEADER, value: Buffer.from(JSON.stringify(renew), "utf8").toString("base64url") },
    ];
    return cfRequest;
}

export function readRenewal(cfRequest) {
    const raw = headerValue(cfRequest?.headers, RENEW_HEADER);
    if (!raw) return null;
    try {
        return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
        return null;
    }
}
