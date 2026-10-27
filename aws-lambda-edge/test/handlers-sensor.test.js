import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetSettingsCache } from "@vqueue/connector-core/settings";
import { _resetNoSensorWarnings } from "@vqueue/connector-core/decide";

// Conector CON tcToken: activación automática de punta a punta. El sensor vive
// en el módulo del handler (uno por contenedor), así que cada test reimporta el
// módulo para arrancar con un sensor limpio.
const SECRET = "test-private-key-abc123";

vi.mock("../src/generated-config.js", () => ({
    CONFIG: {
        client: "orome",
        privateKey: SECRET,
        adminHost: "admin.test",
        tcUrl: "https://tc.test",
        tcToken: "vqtc_orome_0123456789",
        tcTimeoutMs: 100,
        settingsTtlMs: 30000,
        settingsTimeoutMs: 1500,
        verifyTimeoutMs: 2000,
        deadlineMs: 150,
        debug: false,
    },
}));

function settingsBody(rule = {}) {
    return {
        success: true,
        data: {
            client: "orome",
            queue_url: "https://orome.virtual-queue.com",
            cookie_lifetime: 600,
            acls: [{
                action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true,
                threshold: 50, max_load: 0, tolerance: 0.8, buy_time: 600,
                ...rule,
            }],
        },
    };
}

function event({ ip = "203.0.113.7", ua = "Mozilla/5.0" } = {}) {
    return {
        Records: [{
            cf: {
                request: {
                    uri: "/shop/entradas",
                    querystring: "",
                    method: "GET",
                    clientIp: ip,
                    headers: {
                        host: [{ key: "host", value: "shop.test" }],
                        "user-agent": [{ key: "User-Agent", value: ua }],
                    },
                },
            },
        }],
    };
}

let tc;
function stubApi({ state = "inactive", down = false, rejected, rule } = {}) {
    tc = { lines: [] };
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes("/adapter/")) return new Response(JSON.stringify(settingsBody(rule)), { status: 200 });
        if (down) throw new Error("ECONNRESET");
        if (u.endsWith("/v1/ingest")) {
            tc.lines.push(String(init.body).trim().split(" "));
            const body = { data: { "ev-42": state === null ? null : { event_state: state } } };
            if (rejected) body.rejected = rejected;
            return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false }), { status: 400 });
    }));
}

beforeEach(() => {
    vi.resetModules();
    _resetSettingsCache();
    _resetNoSensorWarnings();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("viewer-request con sensor", () => {
    it("evento inactivo: el visitante sin pase pasa al origin y se reporta la llegada", async () => {
        stubApi({ state: "inactive" });
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas"); // request, no 302
        expect(tc.lines).toHaveLength(1);
        // v1 <token> <event_id> <n> <u> <th> <max_load> <tolerance> <buy_time> <ts_ms>
        expect(tc.lines[0]).toEqual(["v1", "vqtc_orome_0123456789", "ev-42", "1", "1", "50", "0", "0.8", "600", "1700000100000"]);
    });

    it("evento activo: 302 a la sala de espera", async () => {
        stubApi({ state: "active" });
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.status).toBe("302");
        expect(res.headers.location[0].value).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("dentro del mismo segundo solo el primer request toca el TC", async () => {
        stubApi({ state: "active" });
        const { handler } = await import("../src/viewer-request/index.js");

        await handler(event({ ip: "1.1.1.1" }));
        await handler(event({ ip: "2.2.2.2" }));
        await handler(event({ ip: "3.3.3.3" }));

        expect(tc.lines).toHaveLength(1);

        Date.now.mockReturnValue(1_700_000_101_100);
        await handler(event({ ip: "4.4.4.4" }));

        expect(tc.lines).toHaveLength(2);
        // 2.2.2.2, 3.3.3.3 y el 4.4.4.4 que disparó el tick.
        expect(tc.lines[1].slice(3, 5)).toEqual(["3", "3"]);
    });

    it("regla sin umbrales: encola siempre y no toca el TC", async () => {
        stubApi({ state: "inactive", rule: { threshold: 0, max_load: 0 } });
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.status).toBe("302");
        expect(tc.lines).toHaveLength(0);
    });

    it("TC caído y sin estado previo: pasa (fail-open)", async () => {
        stubApi({ down: true });
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas");
    });

    it("token rechazado por el TC: encola como siempre y lo loguea", async () => {
        stubApi({ state: null, rejected: { unknown_token: 1 } });
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.status).toBe("302");
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("tcToken"));
    });

    it("el sensor se queda dentro del presupuesto del viewer-request", async () => {
        // TC colgado: el AbortSignal del sensor (100 ms) corta antes que el
        // deadline (150 ms) y el visitante pasa.
        vi.stubGlobal("fetch", vi.fn((url, init) => {
            if (String(url).includes("/adapter/")) return Promise.resolve(new Response(JSON.stringify(settingsBody()), { status: 200 }));
            return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }));
        const { handler } = await import("../src/viewer-request/index.js");

        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas");
    });
});
