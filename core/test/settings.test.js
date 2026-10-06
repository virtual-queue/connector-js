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
