import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENEW_HEADER, cookieHeader } from "../src/cloudfront.js";
import { _resetSettingsCache } from "@vqueue/connector-core/settings";

// Tests de las dos lambdas de punta a punta, con la config inyectada igual que
// lo hace el build (mock del módulo generado).
const SECRET = "test-private-key-abc123";
const ELIXIR_PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";

vi.mock("../src/generated-config.js", () => ({
    CONFIG: {
        client: "orome",
        privateKey: SECRET,
        adminHost: "admin.test",
        settingsTtlMs: 30000,
        settingsTimeoutMs: 1500,
        verifyTimeoutMs: 2000,
        deadlineMs: 150,
        debug: false,
    },
}));

const SETTINGS_BODY = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [
            { action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true },
        ],
    },
};

function event({ uri = "/shop/entradas", querystring = "", method = "GET", cookie = null, extraHeaders = {} } = {}) {
    const headers = { host: [{ key: "host", value: "shop.test" }], ...extraHeaders };
    if (cookie) headers.cookie = [{ key: "cookie", value: cookie }];
    return { Records: [{ cf: { request: { uri, querystring, method, headers } } }] };
}

beforeEach(() => {
    _resetSettingsCache();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
        if (String(url).includes("/adapter/")) {
            return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false }), { status: 400 });
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("viewer-request", () => {
    it("manda a la sala de espera al visitante sin pase", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event());

        expect(res.status).toBe("302");
        expect(res.headers.location[0].value).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("deja pasar al que tiene pase válido y lo marca para renovación", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event({ cookie: `vq_pass_ev-42=${ELIXIR_PASS}` }));

        // Devuelve el request (sigue al origin), no una respuesta.
        expect(res.uri).toBe("/shop/entradas");
        expect(res.headers[RENEW_HEADER]).toBeDefined();
    });

    it("saltea assets sin tocar la red", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event({ uri: "/shop/app.css" }));

        expect(res.uri).toBe("/shop/app.css");
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("descarta un x-vq-renew que venga del visitante, incluso en bypass", async () => {
        const { handler } = await import("../src/viewer-request/index.js");
        const forged = { [RENEW_HEADER]: [{ key: RENEW_HEADER, value: "forjado" }] };

        const res = await handler(event({ uri: "/shop/app.css", extraHeaders: forged }));

        expect(res.headers[RENEW_HEADER]).toBeUndefined();
    });

    it("canjea un token UUID y vuelve al destino sin el token", async () => {
        const token = "11111111-1111-1111-1111-111111111111";
        globalThis.fetch.mockImplementation(async (url) => {
            if (String(url).includes("/adapter/")) {
                return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
            }
            return new Response(
                JSON.stringify({ success: true, data: { event_id: "ev-42", pass: ELIXIR_PASS } }),
                { status: 200 },
            );
        });

        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event({ querystring: `vq_token=${token}&sku=7` }));

        expect(res.status).toBe("302");
        expect(res.headers.location[0].value).toBe("/shop/entradas?sku=7");
        expect(res.headers["set-cookie"][0].value).toContain(`vq_pass_ev-42=${ELIXIR_PASS}`);
    });

    it("si la API de settings se cae, deja pasar (fail-open)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));

        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas"); // pasa al origin, no 302
    });

    it("si todo se cuelga, suelta al visitante antes del timeout de CloudFront", async () => {
        // Un timeout de Lambda@Edge es un 503 para el visitante: no cae en el
        // fail-open de los try/catch. El presupuesto total lo evita.
        vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { })));

        const { handler } = await import("../src/viewer-request/index.js");
        const started = performance.now();
        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas"); // request, no 302
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("una excepción inesperada no rompe el sitio del cliente", async () => {
        // Un evento deforme haría estallar toRequest.
        const { handler } = await import("../src/viewer-request/index.js");
        const broken = { Records: [{ cf: { request: { uri: "/shop", headers: null } } }] };

        const res = await handler(broken);
        expect(res).toBe(broken.Records[0].cf.request);
    });
});

describe("viewer-response", () => {
    it("agrega el Set-Cookie de la renovación a la respuesta del origin", async () => {
        const { handler } = await import("../src/viewer-response/index.js");

        const renew = { name: "vq_pass_ev-42", value: ELIXIR_PASS, maxAge: 600 };
        const marked = Buffer.from(JSON.stringify(renew), "utf8").toString("base64url");

        const res = await handler({
            Records: [{
                cf: {
                    request: { headers: { [RENEW_HEADER]: [{ key: RENEW_HEADER, value: marked }] } },
                    response: { status: "200", headers: {} },
                },
            }],
        });

        expect(res.headers["set-cookie"][0].value).toBe(cookieHeader(renew));
    });

    it("conserva los Set-Cookie que ya traía el origin", async () => {
        const { handler } = await import("../src/viewer-response/index.js");

        const renew = { name: "vq_pass_ev-42", value: "x", maxAge: 600 };
        const marked = Buffer.from(JSON.stringify(renew), "utf8").toString("base64url");

        const res = await handler({
            Records: [{
                cf: {
                    request: { headers: { [RENEW_HEADER]: [{ key: RENEW_HEADER, value: marked }] } },
                    response: {
                        status: "200",
                        headers: { "set-cookie": [{ key: "Set-Cookie", value: "session=abc" }] },
                    },
                },
            }],
        });

        expect(res.headers["set-cookie"]).toHaveLength(2);
        expect(res.headers["set-cookie"][0].value).toBe("session=abc");
    });

    it("sin marca devuelve la respuesta intacta", async () => {
        const { handler } = await import("../src/viewer-response/index.js");
        const response = { status: "200", headers: {} };

        const res = await handler({ Records: [{ cf: { request: { headers: {} }, response } }] });
        expect(res).toBe(response);
    });
});
