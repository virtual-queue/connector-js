import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { _resetSensor, readConfig } from "../src/worker.js";
import { _resetSettingsCache } from "../vendor/settings.js";
import { _resetKeyMismatch, _resetNoSensorWarnings } from "../vendor/decide.js";

// Activación automática: una regla con umbrales solo encola mientras el TC diga
// que el evento está activo. Date.now fijo: el primer request cruza el tick.
const SECRET = "test-private-key-abc123";
const PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";

const ENV = { CLIENT: "orome", PRIVATE_KEY: SECRET, ADMIN_HOST: "admin.test", TC_TOKEN: "tc-tok" };

const SETTINGS = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [
            {
                action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42",
                priority: 0, enabled: true, threshold: 100, max_load: 0, buy_time: 600,
            },
        ],
    },
};

let origin;
let fetchMock;
let tcReply;

function req(path = "/shop/entradas", { cookie } = {}) {
    const headers = new Headers({ "cf-connecting-ip": "1.2.3.4", "user-agent": "test" });
    if (cookie) headers.set("cookie", cookie);
    return new Request(`https://shop.test${path}`, { headers });
}

const tcCalls = () => fetchMock.mock.calls.filter(([u]) => String(u?.url ?? u).endsWith("/v1/ingest"));

beforeEach(() => {
    _resetSettingsCache();
    _resetKeyMismatch();
    _resetNoSensorWarnings();
    _resetSensor();
    tcReply = () => new Response(JSON.stringify({ data: { "ev-42": { event_state: "inactive" } } }), { status: 200 });
    origin = vi.fn(async () => new Response("origin ok", { status: 200 }));
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    fetchMock = vi.fn(async (input, init) => {
        const url = String(input?.url ?? input);
        if (url.includes("/adapter/")) return new Response(JSON.stringify(SETTINGS), { status: 200 });
        if (url.endsWith("/v1/ingest")) return tcReply();
        return origin(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("sensor del TC", () => {
    it("evento inactivo: el visitante pasa directo y el TC recibe los totales", async () => {
        const res = await worker.fetch(req(), ENV);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("origin ok");
        const [[url, init]] = tcCalls();
        expect(url).toBe("https://tc.virtual-queue.com/v1/ingest");
        expect(init.method).toBe("POST");
        expect(init.body).toBe("v1 tc-tok ev-42 1 1 100 0 0.8 600 1700000100000\n");
    });

    it("evento activo: a la cola", async () => {
        tcReply = () => new Response(JSON.stringify({ data: { "ev-42": { event_state: "active" } } }), { status: 200 });
        const res = await worker.fetch(req(), ENV);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("hasta el próximo tick no toca la red y aplica el último estado", async () => {
        tcReply = () => new Response(JSON.stringify({ data: { "ev-42": { event_state: "active" } } }), { status: 200 });
        await worker.fetch(req(), ENV);
        const res = await worker.fetch(req(), ENV);
        expect(res.status).toBe(302);
        expect(tcCalls()).toHaveLength(1);
    });

    it("TC inalcanzable: falla abierto", async () => {
        tcReply = () => { throw new Error("network down"); };
        const res = await worker.fetch(req(), ENV);
        expect(res.status).toBe(200);
    });

    it("token rechazado por el TC: encola siempre, no apaga la protección", async () => {
        tcReply = () => new Response(JSON.stringify({ data: {}, rejected: { unknown_token: 1 } }), { status: 200 });
        vi.spyOn(console, "error").mockImplementation(() => { });
        const res = await worker.fetch(req(), ENV);
        expect(res.status).toBe(302);
    });

    it("el visitante con pase no cuenta ni paga el tick", async () => {
        const res = await worker.fetch(req("/shop/entradas", { cookie: `vq_pass_ev-42=${PASS}` }), ENV);
        expect(res.status).toBe(200);
        expect(tcCalls()).toHaveLength(0);
    });

    it("TC_URL reemplaza la URL por defecto", async () => {
        await worker.fetch(req(), { ...ENV, TC_URL: "https://tc.staging.test/" });
        expect(tcCalls()[0][0]).toBe("https://tc.staging.test/v1/ingest");
    });

    it("deja la decisión en waitUntil para que un tick cortado por el presupuesto termine", async () => {
        const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
        await worker.fetch(req(), ENV, ctx);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    });
});

describe("sin sensor", () => {
    it("sin TC_TOKEN la regla automática encola siempre y no llama al TC", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => { });
        const { TC_TOKEN, ...env } = ENV;
        const res = await worker.fetch(req(), env);
        expect(res.status).toBe(302);
        expect(tcCalls()).toHaveLength(0);
    });

    it("el valor de ejemplo de TC_TOKEN cuenta como sin token", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => { });
        const res = await worker.fetch(req(), { ...ENV, TC_TOKEN: "your-tc-token" });
        expect(res.status).toBe(302);
        expect(tcCalls()).toHaveLength(0);
        expect(readConfig({ ...ENV, TC_TOKEN: " your-tc-token " }).config.tcToken).toBe("");
    });
});
