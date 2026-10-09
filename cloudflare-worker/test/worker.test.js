import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { readConfig } from "../src/worker.js";
import { _resetSettingsCache } from "../vendor/settings.js";

// Mismo pase que firma la implementación real de VQueue (vector del core): vale
// mientras Date.now esté fijado en 1_700_000_100_000.
const SECRET = "test-private-key-abc123";
const PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";
const TOKEN = "11111111-1111-1111-1111-111111111111";

const ENV = { CLIENT: "orome", PRIVATE_KEY: SECRET, ADMIN_HOST: "admin.test" };

const SETTINGS = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [
            // Fuera de orden a propósito: el 0 tiene que pisar al 5.
            { action: "bypass", pattern: "/shop/ayuda", pattern_type: "prefix", event_id: null, priority: 5, enabled: true },
            { action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true },
        ],
    },
};

let origin;
let fetchMock;

function req(path = "/shop/entradas", { method = "GET", cookie, headers = {} } = {}) {
    const h = new Headers(headers);
    if (cookie) h.set("cookie", cookie);
    return new Request(`https://shop.test${path}`, { method, headers: h });
}

beforeEach(() => {
    _resetSettingsCache();
    origin = vi.fn(async () => new Response("origin ok", { status: 200 }));
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    fetchMock = vi.fn(async (input, init) => {
        const url = String(input?.url ?? input);
        if (url.includes("/adapter/")) return new Response(JSON.stringify(SETTINGS), { status: 200 });
        if (url.includes("/queue/verify")) {
            return new Response(
                JSON.stringify({ success: true, data: { token: TOKEN, event_id: "ev-42", pass: PASS } }),
                { status: 200 },
            );
        }
        return origin(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("redirect a la sala de espera", () => {
    it("manda a la cola al visitante sin pase y recuerda el destino", async () => {
        const res = await worker.fetch(req("/shop/entradas?x=1"), ENV);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://orome.virtual-queue.com/queue/ev-42");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const setCookie = res.headers.get("set-cookie");
        expect(setCookie).toContain("vq_target_ev-42=");
        expect(setCookie).toContain("HttpOnly");
        expect(origin).not.toHaveBeenCalled();
    });

    it("la regla de menor número gana, como en un firewall", async () => {
        // /shop/ayuda matchea las dos: gana la 0 (redirect), no la 5 (bypass).
        const res = await worker.fetch(req("/shop/ayuda"), ENV);
        expect(res.status).toBe(302);
    });
});

describe("visitante con pase", () => {
    it("pasa al origin y renueva el pase", async () => {
        const res = await worker.fetch(req("/shop/entradas", { cookie: `vq_pass_ev-42=${PASS}` }), ENV);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("origin ok");
        const renewed = res.headers.get("set-cookie");
        expect(renewed).toContain("vq_pass_ev-42=");
        expect(renewed).toContain("Max-Age=600");
    });

    it("un pase firmado con otra clave no entra", async () => {
        const res = await worker.fetch(req("/shop/entradas", { cookie: `vq_pass_ev-42=${PASS}` }), { ...ENV, PRIVATE_KEY: "otra-clave" });
        expect(res.status).toBe(302);
    });
});

describe("vuelta de la cola", () => {
    it("canjea el token, emite el pase y vuelve al destino guardado", async () => {
        const res = await worker.fetch(
            req(`/shop/entradas?vq_token=${TOKEN}`, { cookie: "vq_target_ev-42=%2Fshop%2Fshow%3Fid%3D7" }),
            ENV,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://shop.test/shop/show?id=7");
        const cookies = res.headers.getSetCookie();
        expect(cookies.some((c) => c.startsWith("vq_pass_ev-42="))).toBe(true);
        expect(cookies.some((c) => c.startsWith("vq_target_ev-42=;") && c.includes("Max-Age=0"))).toBe(true);
    });

    it("acepta el ?token= legacy y lo saca de la URL", async () => {
        const res = await worker.fetch(req(`/shop/entradas?token=${TOKEN}&x=1`), ENV);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://shop.test/shop/entradas?x=1");
    });

    it("un ?token= propio del sitio no se secuestra", async () => {
        fetchMock.mockImplementation(async (input, init) => {
            const url = String(input?.url ?? input);
            if (url.includes("/adapter/")) return new Response(JSON.stringify(SETTINGS), { status: 200 });
            if (url.includes("/queue/verify")) return new Response(JSON.stringify({ success: false }), { status: 400 });
            return origin(input, init);
        });
        // No es un token de cola: sigue el flujo normal (sin pase → cola, sin loop).
        const res = await worker.fetch(req(`/shop/entradas?token=${TOKEN}`), ENV);
        expect(res.headers.get("location")).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("no canjea tokens que no son UUID", async () => {
        await worker.fetch(req("/shop/entradas?token=reset-abc"), ENV);
        expect(fetchMock.mock.calls.some(([u]) => String(u?.url ?? u).includes("/queue/verify"))).toBe(false);
    });
});

describe("bypass", () => {
    it("assets, /api/, websockets y métodos distintos de GET/HEAD pasan sin red", async () => {
        for (const r of [
            req("/shop/app.css"),
            req("/api/cart"),
            req("/shop/entradas", { method: "POST" }),
            req("/shop/live", { headers: { Upgrade: "websocket" } }),
        ]) {
            const res = await worker.fetch(r, ENV);
            expect(res.status).toBe(200);
        }
        expect(fetchMock.mock.calls.some(([u]) => String(u?.url ?? u).includes("/adapter/"))).toBe(false);
    });

    it("rutas sin regla pasan", async () => {
        const res = await worker.fetch(req("/blog"), ENV);
        expect(res.status).toBe(200);
    });
});

describe("falla abierto", () => {
    it("sin PRIVATE_KEY deja pasar a todos", async () => {
        const res = await worker.fetch(req(), { CLIENT: "orome" });
        expect(res.status).toBe(200);
    });

    it("con CLIENT sin cambiar (your-subdomain) deja pasar", async () => {
        const res = await worker.fetch(req(), { ...ENV, CLIENT: "your-subdomain" });
        expect(res.status).toBe(200);
    });

    it("si la API de reglas no responde, deja pasar", async () => {
        fetchMock.mockImplementation(async (input, init) => {
            const url = String(input?.url ?? input);
            if (url.includes("/adapter/")) throw new Error("network down");
            return origin(input, init);
        });
        const res = await worker.fetch(req(), ENV);
        expect(res.status).toBe(200);
    });

    it("si el canje falla con error de red, no rompe: sigue el flujo normal", async () => {
        fetchMock.mockImplementation(async (input, init) => {
            const url = String(input?.url ?? input);
            if (url.includes("/adapter/")) return new Response(JSON.stringify(SETTINGS), { status: 200 });
            if (url.includes("/queue/verify")) throw new Error("timeout");
            return origin(input, init);
        });
        const res = await worker.fetch(req(`/shop/entradas?vq_token=${TOKEN}`), ENV);
        expect(res.status).toBe(302); // sin pase → cola, no 500
    });
});

describe("readConfig", () => {
    it("pide client y privateKey", () => {
        expect(readConfig({}).errors.length).toBeGreaterThan(0);
        expect(readConfig(ENV).errors).toEqual([]);
    });
});
