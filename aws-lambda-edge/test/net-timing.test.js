import { describe, it, expect, afterEach } from "vitest";
import dc from "node:diagnostics_channel";
import http from "node:http";
import { cpuMs, startNetTiming } from "../src/net-timing.js";

const publish = (name, message) => dc.channel(name).publish(message);

function clocks() {
    let wall = 10_000;
    let cpu = 500;
    return {
        now: () => wall,
        cpu: () => cpu,
        advance: (wallMs, cpuMsSpent = 0) => {
            wall += wallMs;
            cpu += cpuMsSpent;
        },
    };
}

let timing = null;
afterEach(() => {
    timing?.stop();
    timing = null;
});

describe("net-timing — eventos de undici", () => {
    it("un fetch que abre socket deja la conexión y el ttfb como `new`", () => {
        const c = clocks();
        timing = startNetTiming({ now: c.now, cpu: c.cpu });
        const request = { origin: "https://clients.virtual-queue.com", method: "GET", path: "/api/v1/adapter/orome/settings" };
        const connectParams = { host: "clients.virtual-queue.com", hostname: "clients.virtual-queue.com", protocol: "https:" };

        publish("undici:request:create", { request });
        c.advance(2);
        publish("undici:client:beforeConnect", { connectParams, connector: () => {} });
        c.advance(1500, 104);
        publish("undici:client:connected", { connectParams, connector: () => {}, socket: {} });
        c.advance(200, 14);
        publish("undici:request:headers", { request, response: { statusCode: 200 } });

        expect(timing.drain()).toEqual([
            "[timing] connect clients.virtual-queue.com 1500ms cpu=104ms",
            "[timing] ttfb clients.virtual-queue.com 1702ms cpu=118ms 200 new",
        ]);
    });

    it("un fetch sobre un socket abierto no tiene línea de conexión y sale `reused`", () => {
        const c = clocks();
        timing = startNetTiming({ now: c.now, cpu: c.cpu });
        const request = { origin: "https://orome.virtual-queue.com" };

        publish("undici:request:create", { request });
        c.advance(210, 6);
        publish("undici:request:headers", { request, response: { statusCode: 200 } });

        expect(timing.drain()).toEqual(["[timing] ttfb orome.virtual-queue.com 210ms cpu=6ms 200 reused"]);
    });

    it("una conexión que falla y un request abortado dicen por qué", () => {
        const c = clocks();
        timing = startNetTiming({ now: c.now, cpu: c.cpu });
        const request = { origin: "https://clients.virtual-queue.com" };
        const connectParams = { host: "clients.virtual-queue.com" };

        publish("undici:request:create", { request });
        publish("undici:client:beforeConnect", { connectParams });
        c.advance(3000, 200);
        publish("undici:client:connectError", { connectParams, error: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
        publish("undici:request:error", { request, error: Object.assign(new Error("aborted"), { name: "TimeoutError" }) });

        expect(timing.drain()).toEqual([
            "[timing] connect clients.virtual-queue.com 3000ms cpu=200ms error UND_ERR_CONNECT_TIMEOUT",
            "[timing] ttfb clients.virtual-queue.com 3000ms cpu=200ms error TimeoutError new",
        ]);
    });

    it("de un abort muestra el nombre y no el código numérico 20", () => {
        const c = clocks();
        timing = startNetTiming({ now: c.now, cpu: c.cpu });
        const request = { origin: "https://clients.virtual-queue.com" };

        publish("undici:request:create", { request });
        c.advance(3000, 40);
        publish("undici:request:error", { request, error: new DOMException("This operation was aborted", "AbortError") });

        expect(timing.drain()).toEqual(["[timing] ttfb clients.virtual-queue.com 3000ms cpu=40ms error AbortError reused"]);
    });

    it("drain vacía el buffer y el buffer tiene tope", () => {
        const c = clocks();
        timing = startNetTiming({ now: c.now, cpu: c.cpu, maxLines: 2 });

        for (let i = 0; i < 5; i++) {
            const request = { origin: `https://h${i}.test` };
            publish("undici:request:create", { request });
            publish("undici:request:headers", { request, response: { statusCode: 204 } });
        }

        expect(timing.drain()).toHaveLength(2);
        expect(timing.drain()).toEqual([]);
    });

    it("stop deja de escuchar", () => {
        timing = startNetTiming();
        timing.stop();
        const request = { origin: "https://x.test" };
        publish("undici:request:create", { request });
        publish("undici:request:headers", { request, response: { statusCode: 200 } });

        expect(timing.drain()).toEqual([]);
    });
});

describe("net-timing — con el fetch real de Node", () => {
    it("ve las conexiones nuevas y los sockets reusados", async () => {
        const server = http.createServer((_req, res) => res.end("{}"));
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${server.address().port}/settings`;

        try {
            timing = startNetTiming();
            // Cuántos sockets abre undici para fetches seguidos es cosa suya
            // (contra un server local el segundo a veces abre otro): lo que
            // importa es que cada `new` tenga su `connect` y que haya reuso.
            for (let i = 0; i < 4; i++) await (await fetch(url)).text();

            const lines = timing.drain();
            const connects = lines.filter((l) => l.startsWith("[timing] connect 127.0.0.1:"));
            const ttfbs = lines.filter((l) => l.startsWith("[timing] ttfb 127.0.0.1:"));

            expect(ttfbs).toHaveLength(4);
            expect(ttfbs[0]).toMatch(/ \d+ms cpu=\d+ms 200 new$/);
            expect(connects[0]).toMatch(/^\[timing\] connect 127\.0\.0\.1:\d+ \d+ms cpu=\d+ms$/);
            expect(ttfbs.filter((l) => l.endsWith(" new"))).toHaveLength(connects.length);
            expect(ttfbs.at(-1)).toMatch(/ 200 reused$/);
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it("cpuMs crece con trabajo de CPU", () => {
        const before = cpuMs();
        let x = 0;
        for (let i = 0; i < 5_000_000; i++) x += Math.sqrt(i);
        expect(x).toBeGreaterThan(0);
        expect(cpuMs()).toBeGreaterThan(before);
    });
});
