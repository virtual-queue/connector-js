import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dc from "node:diagnostics_channel";
import { _resetSettingsCache } from "@vqueue/connector-core/settings";

// Con `debug`, el handler loguea la CPU de cada fase y la red de cada fetch.
// El fetch se simula, así que los eventos de undici se publican a mano con la
// misma forma que los publica el fetch de Node.
vi.mock("../src/generated-config.js", () => ({
    CONFIG: {
        client: "orome",
        privateKey: "test-private-key-abc123",
        adminHost: "admin.test",
        settingsTtlMs: 30000,
        settingsTimeoutMs: 3000,
        verifyTimeoutMs: 2000,
        deadlineMs: 1000,
        debug: true,
    },
}));

const SETTINGS_BODY = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [{ action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true }],
    },
};

const event = () => ({
    Records: [{ cf: { request: { uri: "/shop/entradas", querystring: "", method: "GET", headers: { host: [{ key: "host", value: "shop.test" }] } } } }],
});

const publish = (name, message) => dc.channel(name).publish(message);

let logs;

beforeEach(() => {
    _resetSettingsCache();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    vi.stubGlobal("fetch", vi.fn(async () => {
        const request = { origin: "https://admin.test", method: "GET", path: "/api/v1/adapter/orome/settings" };
        const connectParams = { host: "admin.test", hostname: "admin.test", protocol: "https:" };
        publish("undici:request:create", { request });
        publish("undici:client:beforeConnect", { connectParams });
        publish("undici:client:connected", { connectParams, socket: {} });
        publish("undici:request:headers", { request, response: { statusCode: 200 } });
        return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const timingLines = () => logs.filter((l) => l.startsWith("[timing]"));

describe("viewer-request con debug", () => {
    it("carga el fetch al importar el módulo, es decir en el Init", async () => {
        await import("../src/viewer-request/index.js");

        expect(logs).toContainEqual(expect.stringMatching(/^\[timing\] preload \d+ms cpu=\d+ms init$/));
    });

    it("cada fase trae su CPU y la red sale antes de la línea del request", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        await handler(event());

        const lines = timingLines();
        expect(lines).toContainEqual(expect.stringMatching(/^\[timing\] settings \d+ms cpu=\d+ms ok$/));
        expect(lines).toContainEqual(expect.stringMatching(/^\[timing\] decide \d+ms cpu=\d+ms redirect$/));
        expect(lines.at(-1)).toMatch(/^\[timing\] request \d+ms cpu=\d+ms cold$/);

        const connect = lines.findIndex((l) => /^\[timing\] connect admin\.test \d+ms cpu=\d+ms$/.test(l));
        const ttfb = lines.findIndex((l) => /^\[timing\] ttfb admin\.test \d+ms cpu=\d+ms 200 new$/.test(l));
        expect(connect).toBeGreaterThan(-1);
        expect(ttfb).toBeGreaterThan(connect);
        expect(ttfb).toBeLessThan(lines.length - 1);
    });

    it("una invocación tibia sin red no arrastra líneas de la anterior", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        await handler(event());
        logs.length = 0;

        await handler(event());

        const lines = timingLines();
        expect(lines.some((l) => l.startsWith("[timing] connect") || l.startsWith("[timing] ttfb"))).toBe(false);
        expect(lines.at(-1)).toMatch(/^\[timing\] request \d+ms cpu=\d+ms warm$/);
    });
});
