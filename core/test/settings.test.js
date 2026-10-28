import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSettings, resolveCookieLifetime, _resetSettingsCache } from "../src/settings.js";
import { sortRules } from "../src/acl.js";

const BODY = (over = {}) => ({
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [{ action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true }],
        ...over,
    },
});

const ok = (body) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
const logger = { log() { }, warn() { }, error() { } };

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

beforeEach(() => _resetSettingsCache());

describe("settings — cache", () => {
    it("cachea por endpoint: dos guards en el mismo proceso no se mezclan", async () => {
        const a = ok(BODY({ client: "a" }));
        const b = ok(BODY({ client: "b" }));
        const { now } = clock();

        const sa = await getSettings({ client: "a" }, { sortRules, logger, now, fetchImpl: a });
        const sb = await getSettings({ client: "b" }, { sortRules, logger, now, fetchImpl: b });

        expect(sa.client).toBe("a");
        expect(sb.client).toBe("b");
        // Y el segundo pedido de cada uno sale del cache.
        await getSettings({ client: "a" }, { sortRules, logger, now, fetchImpl: a });
        expect(a).toHaveBeenCalledTimes(1);
    });

    it("ante un fallo sirve la última config buena y no reintenta en cada request", async () => {
        const c = clock();
        const fetchImpl = ok(BODY());
        const config = { client: "orome", settingsTtlMs: 1000 };

        const fresh = await getSettings(config, { sortRules, logger, now: c.now, fetchImpl });
        expect(fresh.rules).toHaveLength(1);

        c.advance(2000); // vencido
        fetchImpl.mockImplementation(async () => { throw new Error("ECONNRESET"); });

        const stale = await getSettings(config, { sortRules, logger, now: c.now, fetchImpl });
        expect(stale).toBe(fresh);

        // Dentro de la ventana de degradación no vuelve a golpear la API.
        await getSettings(config, { sortRules, logger, now: c.now, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("sin config previa, un fallo devuelve null y tampoco martilla la API", async () => {
        const c = clock();
        const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

        expect(await getSettings({ client: "x" }, { sortRules, logger, now: c.now, fetchImpl })).toBeNull();
        expect(await getSettings({ client: "x" }, { sortRules, logger, now: c.now, fetchImpl })).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("sin queue_url no hay settings (fail-open explícito)", async () => {
        const fetchImpl = ok(BODY({ queue_url: null }));
        expect(await getSettings({ client: "x" }, { sortRules, logger, fetchImpl })).toBeNull();
    });

    it("normaliza cookie_lifetime como el Worker y el adapter", () => {
        expect(resolveCookieLifetime(600)).toBe(600);
        expect(resolveCookieLifetime("900")).toBe(900);
        expect(resolveCookieLifetime(0)).toBe(600);
        expect(resolveCookieLifetime(-5)).toBe(600);
        expect(resolveCookieLifetime("abc")).toBe(600);
        expect(resolveCookieLifetime(999_999)).toBe(86_400);
    });
});

describe("settings — parámetros del lazo", () => {
    it("conserva threshold, max_load, tolerance y buy_time de cada regla", async () => {
        const fetchImpl = ok(BODY({
            acls: [{ action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true, threshold: 100, max_load: 500, tolerance: 0.8, buy_time: 600 }],
        }));
        const settings = await getSettings({ client: "loop" }, { sortRules, logger, fetchImpl });

        expect(settings.rules[0]).toMatchObject({ threshold: 100, max_load: 500, tolerance: 0.8, buy_time: 600 });
    });
});

describe("settings — stale-while-revalidate", () => {
    it("vencido pero no rancio: sirve la copia vieja y refresca aparte", async () => {
        const c = clock();
        let release;
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY()), { status: 200 }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                release = () => resolve(new Response(JSON.stringify(BODY({ cookie_lifetime: 900 })), { status: 200 }));
            }));
        const config = { client: "swr", settingsTtlMs: 1000 };
        const deps = { sortRules, logger, now: c.now, fetchImpl };

        const first = await getSettings(config, deps);
        c.advance(2000); // vencido

        // No espera al fetch en vuelo: vuelve con la copia vieja al instante.
        const stale = await getSettings(config, deps);
        expect(stale).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // Mientras el refresco sigue en vuelo, tampoco se dispara otro.
        expect(await getSettings(config, deps)).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        release();
        await new Promise((r) => setTimeout(r, 0));
        expect((await getSettings(config, deps)).cookieLifetime).toBe(900);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("rancio (más de cinco minutos) vuelve a bloquear hasta tener una copia fresca", async () => {
        const c = clock();
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY()), { status: 200 }))
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY({ cookie_lifetime: 900 })), { status: 200 }));
        const config = { client: "old", settingsTtlMs: 1000 };
        const deps = { sortRules, logger, now: c.now, fetchImpl };

        await getSettings(config, deps);
        c.advance(301_000);

        expect((await getSettings(config, deps)).cookieLifetime).toBe(900);
    });

    it("si el refresco de fondo falla, el próximo request espera uno nuevo y recién ahí se cachea el fallo", async () => {
        const c = clock();
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY()), { status: 200 }))
            .mockImplementation(async () => { throw new Error("ECONNRESET"); });
        const config = { client: "bg", settingsTtlMs: 1000 };
        const deps = { sortRules, logger, now: c.now, fetchImpl };

        const first = await getSettings(config, deps);
        c.advance(2000);

        expect(await getSettings(config, deps)).toBe(first);
        await new Promise((r) => setTimeout(r, 0)); // el refresco de fondo falló

        // Este espera su propio fetch; falla también y sirve la copia vieja.
        expect(await getSettings(config, deps)).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(3);

        // Ahora sí el fallo queda cacheado: no se martilla la API.
        expect(await getSettings(config, deps)).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("Lambda congelada: un refresco abortado al descongelar no deja la copia vieja pegada", async () => {
        const c = clock();
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY()), { status: 200 }))
            .mockImplementationOnce(async () => { throw new Error("The operation was aborted due to timeout"); })
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY({ cookie_lifetime: 900 })), { status: 200 }));
        const config = { client: "abort", settingsTtlMs: 1000 };
        const deps = { sortRules, logger, now: c.now, fetchImpl };

        const first = await getSettings(config, deps);
        c.advance(2000);
        expect(await getSettings(config, deps)).toBe(first); // arranca el refresco de fondo
        await new Promise((r) => setTimeout(r, 0)); // se aborta al descongelar

        c.advance(10_000);
        expect((await getSettings(config, deps)).cookieLifetime).toBe(900);
    });

    it("Lambda congelada: un refresco en vuelo más viejo que el timeout se abandona y se espera uno nuevo", async () => {
        const c = clock();
        const fetchImpl = vi.fn()
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY()), { status: 200 }))
            .mockImplementationOnce(() => new Promise(() => { })) // congelado: nunca vuelve
            .mockImplementationOnce(async () => new Response(JSON.stringify(BODY({ cookie_lifetime: 900 })), { status: 200 }));
        const config = { client: "frozen", settingsTtlMs: 1000, settingsTimeoutMs: 3000 };
        const deps = { sortRules, logger, now: c.now, fetchImpl };

        const first = await getSettings(config, deps);
        c.advance(2000);
        expect(await getSettings(config, deps)).toBe(first);

        // Dentro del timeout se sigue confiando en el refresco en vuelo.
        c.advance(1000);
        expect(await getSettings(config, deps)).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // Pasado el timeout se lo da por muerto.
        c.advance(5000);
        expect((await getSettings(config, deps)).cookieLifetime).toBe(900);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("sin copia previa se espera al fetch, como siempre", async () => {
        const fetchImpl = ok(BODY());
        const s = await getSettings({ client: "cold" }, { sortRules, logger, fetchImpl });
        expect(s.rules).toHaveLength(1);
    });
});
