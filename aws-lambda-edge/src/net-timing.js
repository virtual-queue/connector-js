// Red por dentro de cada fetch: abrir la conexión contra esperar la respuesta.
//
// Para qué: `[timing] settings 1800ms` no dice si esos 1,8 s fueron abrir una
// conexión nueva (DNS + TCP + TLS) o esperar al servidor. El `fetch` de Node es
// undici, que publica eventos en `node:diagnostics_channel`: escuchándolos se ve
// cada conexión que se abre y cuándo llegan los headers, sin tocar las llamadas.
//
// Las líneas se juntan y se sueltan al final de cada invocación (`drain`), con
// el logger que ya sabe si `debug` está encendido. En el camino A ese logger
// recién existe cuando llegó el secreto, y la primera conexión del contenedor
// (la de Secrets Manager) se perdería si se logueara en el momento.
//
//   [timing] connect clients.virtual-queue.com 1520ms cpu=104ms
//   [timing] ttfb clients.virtual-queue.com 1700ms cpu=118ms 200 new
//   [timing] ttfb orome.virtual-queue.com 210ms cpu=6ms 200 reused
//
// `connect` sale solo cuando se abrió un socket, con DNS, TCP y TLS juntos.
// `ttfb` va desde que se crea el request hasta los headers de la respuesta, e
// incluye la conexión cuando fue `new`. `cpu=` es la CPU que gastó el proceso
// en ese intervalo (ver core/src/timing.js para cómo leerla). Un fetch que
// sigue en vuelo cuando el handler ya soltó al visitante (deadline) sale en la
// invocación siguiente.

import dc from "node:diagnostics_channel";
import process from "node:process";

const CHANNELS = {
    beforeConnect: "undici:client:beforeConnect",
    connected: "undici:client:connected",
    connectError: "undici:client:connectError",
    create: "undici:request:create",
    headers: "undici:request:headers",
    error: "undici:request:error",
};

// Topes de memoria por contenedor: el buffer se vacía en cada invocación, pero
// un request que nunca termina no puede quedar referenciado para siempre.
const MAX_LINES = 50;
const MAX_INFLIGHT = 100;

/** CPU que lleva gastada el proceso, en ms. */
export function cpuMs() {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
}

function hostOf(origin) {
    try {
        return new URL(String(origin)).host;
    } catch {
        return String(origin);
    }
}

// Los errores de undici traen un `code` de texto (UND_ERR_CONNECT_TIMEOUT). Un
// abort es un DOMException, cuyo `code` es el número legado 20: ahí dice más el
// nombre (AbortError, TimeoutError).
function reasonOf(error) {
    if (typeof error?.code === "string" && error.code) return error.code;
    return error?.name || "unknown";
}

/**
 * Empieza a escuchar los eventos de undici. Devuelve `drain()`, que entrega y
 * vacía las líneas juntadas, y `stop()`, que deja de escuchar.
 */
export function startNetTiming({ now = Date.now, cpu = cpuMs, maxLines = MAX_LINES } = {}) {
    let lines = [];
    const connecting = new Map(); // host -> [{w, c}], en orden de apertura
    const inflight = new Map(); // request de undici -> {host, w, c, fresh}

    const mark = () => ({ w: now(), c: cpu() });
    const since = (start) => `${Math.round(now() - start.w)}ms cpu=${Math.round(cpu() - start.c)}ms`;
    const push = (line) => {
        if (lines.length < maxLines) lines.push(line);
    };

    function takeConnect(host) {
        const queue = connecting.get(host);
        const start = queue?.shift();
        if (queue && queue.length === 0) connecting.delete(host);
        return start;
    }

    const handlers = {
        [CHANNELS.beforeConnect]: ({ connectParams }) => {
            const host = connectParams?.host;
            const queue = connecting.get(host) ?? [];
            queue.push(mark());
            connecting.set(host, queue);
            // El request que espera este socket no lo reusó.
            for (const req of inflight.values()) {
                if (req.host === host) req.fresh = true;
            }
        },
        [CHANNELS.connected]: ({ connectParams }) => {
            const host = connectParams?.host;
            const start = takeConnect(host);
            if (start) push(`[timing] connect ${host} ${since(start)}`);
        },
        [CHANNELS.connectError]: ({ connectParams, error }) => {
            const host = connectParams?.host;
            const start = takeConnect(host);
            if (start) push(`[timing] connect ${host} ${since(start)} error ${reasonOf(error)}`);
        },
        [CHANNELS.create]: ({ request }) => {
            if (inflight.size >= MAX_INFLIGHT) inflight.delete(inflight.keys().next().value);
            inflight.set(request, { host: hostOf(request?.origin), ...mark(), fresh: false });
        },
        [CHANNELS.headers]: ({ request, response }) => {
            const start = inflight.get(request);
            if (!start) return;
            inflight.delete(request);
            push(`[timing] ttfb ${start.host} ${since(start)} ${response?.statusCode} ${start.fresh ? "new" : "reused"}`);
        },
        [CHANNELS.error]: ({ request, error }) => {
            const start = inflight.get(request);
            if (!start) return;
            inflight.delete(request);
            push(`[timing] ttfb ${start.host} ${since(start)} error ${reasonOf(error)} ${start.fresh ? "new" : "reused"}`);
        },
    };

    for (const [name, fn] of Object.entries(handlers)) dc.subscribe(name, fn);

    return {
        drain() {
            const out = lines;
            lines = [];
            return out;
        },
        stop() {
            for (const [name, fn] of Object.entries(handlers)) dc.unsubscribe(name, fn);
        },
    };
}
