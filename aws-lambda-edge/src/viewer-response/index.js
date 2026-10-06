// Lambda@Edge — viewer-response.
//
// Única razón de existir: renovar el pase de forma deslizante. En Lambda@Edge,
// viewer-request puede devolver una respuesta propia (el 302 a la cola), pero
// NO puede agregarle una cookie a una respuesta que viene del origin. Para eso
// hace falta esta segunda función.
//
// Sin esto, el pase sería un presupuesto fijo desde que el visitante sale de la
// fila (cookie_lifetime, 10 min por defecto) y cualquier compra más lenta que el
// promedio vencería a mitad de camino, devolviendo al visitante a la cola.

import { cookieHeader, readRenewal } from "../cloudfront.js";

export async function handler(event) {
    const { request, response } = event.Records[0].cf;

    try {
        const renew = readRenewal(request);
        if (!renew?.name || !renew?.value) return response;

        const existing = response.headers["set-cookie"] || [];
        response.headers["set-cookie"] = [
            ...existing,
            { key: "Set-Cookie", value: cookieHeader(renew) },
        ];

        return response;
    } catch (err) {
        // Nunca romper la respuesta del origin por no poder renovar: en el peor
        // caso el pase vence antes y el visitante vuelve a la cola.
        console.error(`[vq] no se pudo renovar el pase: ${err?.stack || err}`);
        return response;
    }
}
