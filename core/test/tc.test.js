import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSensor, buildTcLine, tcTokenOf, tcUrlOf, RATE_DEDUPE_MS, DEFAULT_TOLERANCE } from "../src/tc.js";

const CONFIG = { tcUrl: "https://tc.test/", tcToken: "vqtc_token_0123456789", tcTickMs: 1000, tcTimeoutMs: 500, tcStaleMs: 60_000 };
const PARAMS = { threshold: 100, maxLoad: 0, tolerance: 0.8, buyTime: 600 };
const logger = { log: () => { }, warn: () => { }, error: () => { } };

// Reloj controlado: el sensor no usa timers, solo `now()`.
let clock;
const now = () => clock;

// TC falso: guarda cada línea recibida y contesta como el real
// ({data: {<event>: estado | null}, rejected?: {...}}).
function fakeTc({ state = "inactive", status = 200, rejected, pending = false } = {}) {
    const lines = [];
    const fetchImpl = vi.fn(async (url, init) => {
        lines.push({ url: String(url), headers: init.headers, body: init.body, method: init.method });
        if (status !== 200) return new Response("", { status });
        const body = { data: {} };
        for (const line of String(init.body).split("\n")) {
            if (!line) continue;
            const eventId = line.split(" ")[2];
            body.data[eventId] = pending ? null : { event_state: state, decision: "keep_status", ema: 1, l: 1, updated_at: 1 };
        }
        if (rejected) body.rejected = rejected;
        return new Response(JSON.stringify(body), { status: 200 });
    });
    return { fetchImpl, lines };
}

const fields = (line) => line.trim().split(" ");

beforeEach(() => {
    clock = 1_700_000_000_000;
});

afterEach(() => vi.restoreAllMocks());

describe("buildTcLine — lo que el TC acepta", () => {
    it("arma los 10 campos en el orden del protocolo v1", () => {
        const f = fields(buildTcLine("tok", "ev-42", 7, 5, PARAMS, 1_700_000_000_123));
        expect(f).toEqual(["v1", "tok", "ev-42", "7", "5", "100", "0", "0.8", "600", "1700000000123"]);
        expect(buildTcLine("tok", "ev-42", 1, 1, PARAMS, 1)).toMatch(/\n$/);
    });

    it("sanea los valores: u <= n, umbrales >= 0, tolerance en [0,1], buy_time entero", () => {
        const f = fields(buildTcLine("tok", "ev", 3, 9, { threshold: -5, maxLoad: "abc", tolerance: 1.7, buyTime: 59.6 }, 0));
        expect(f.slice(3)).toEqual(["3", "3", "0", "0", String(DEFAULT_TOLERANCE), "60", "0"]);
    });

    it("sin tolerance usa el default del Worker", () => {
        const f = fields(buildTcLine("tok", "ev", 0, 0, { tolerance: null }, 0));
        expect(f[7]).toBe(String(DEFAULT_TOLERANCE));
    });
});

describe("createSensor — sin token no hay sensor", () => {
    it("devuelve null sin tcToken, vacío o con placeholder", () => {
        expect(createSensor({ tcUrl: "https://tc.test" }, { logger })).toBeNull();
        expect(createSensor({ tcUrl: "https://tc.test", tcToken: "" }, { logger })).toBeNull();
        expect(createSensor({ tcUrl: "https://tc.test", tcToken: "__VQ_TC_TOKEN__" }, { logger })).toBeNull();
        expect(tcTokenOf({ tcToken: "__VQ_TC_TOKEN__" })).toBeNull();
        expect(tcTokenOf({ tcToken: " tok " })).toBe("tok");
    });

    it("sin tcUrl usa la del TC de VQueue; una URL inválida deshabilita el sensor con error", () => {
        expect(tcUrlOf({})).toBe("https://tc.virtual-queue.com");
        expect(tcUrlOf({ tcUrl: "https://tc.test///" })).toBe("https://tc.test");
        expect(tcUrlOf({ tcUrl: "tc.test" })).toBeNull();
        const error = vi.fn();
        expect(createSensor({ tcUrl: "tc.test", tcToken: "tok" }, { logger: { ...logger, error } })).toBeNull();
        expect(error).toHaveBeenCalled();
    });
});

describe("createSensor — tick y lotes", () => {
    it("el primer arribo manda la línea al TC y aplica el estado de la respuesta", async () => {
        const { fetchImpl, lines } = fakeTc({ state: "active" });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "1.1.1.1|ua", PARAMS)).toBe("active");

        expect(lines).toHaveLength(1);
        expect(lines[0].url).toBe("https://tc.test/v1/ingest");
        expect(lines[0].method).toBe("POST");
        expect(lines[0].headers["Content-Type"]).toBe("text/plain");
        expect(fields(lines[0].body)).toEqual(["v1", CONFIG.tcToken, "ev-42", "1", "1", "100", "0", "0.8", "600", String(clock)]);
    });

    it("entre ticks no toca la red y devuelve el estado cacheado", async () => {
        const { fetchImpl } = fakeTc({ state: "inactive" });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += 300;
        expect(await sensor.observe("ev-42", "b|ua", PARAMS)).toBe("inactive");
        clock += 300;
        expect(await sensor.observe("ev-42", "c|ua", PARAMS)).toBe("inactive");

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("manda los totales acumulados en el próximo tick y los reinicia", async () => {
        const { fetchImpl, lines } = fakeTc();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS); // tick 1: n=1
        clock += 400;
        await sensor.observe("ev-42", "b|ua", PARAMS);
        await sensor.observe("ev-42", "c|ua", PARAMS);
        clock += 700; // cruza el tick
        await sensor.observe("ev-42", "d|ua", PARAMS); // tick 2

        expect(lines).toHaveLength(2);
        expect(fields(lines[1].body).slice(3, 5)).toEqual(["3", "3"]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("dedupe: el mismo cliente repetido en la ventana cuenta una vez", async () => {
        const { fetchImpl, lines } = fakeTc();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += 100;
        await sensor.observe("ev-42", "a|ua", PARAMS);
        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += 1000;
        await sensor.observe("ev-42", "x|ua", PARAMS);

        expect(fields(lines[1].body).slice(3, 5)).toEqual(["1", "1"]); // solo "x"
    });

    it("u usa la ventana de buy_time: el mismo cliente tras 2s cuenta como llegada pero no como único", async () => {
        const { fetchImpl, lines } = fakeTc();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += RATE_DEDUPE_MS * 2 + 1; // fuera de la ventana de llegadas, dentro de la de únicos
        await sensor.observe("ev-42", "a|ua", PARAMS); // se cuenta y dispara el tick 2

        expect(fields(lines[1].body).slice(3, 5)).toEqual(["1", "0"]);
    });

    it("buy_time de la regla fija la ventana de únicos y sigue sus cambios", async () => {
        const { fetchImpl } = fakeTc();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", { ...PARAMS, buyTime: 30 });
        expect(sensor._entry("ev-42").uniqueDedupe.windowMs).toBe(30_000);

        await sensor.observe("ev-42", "a|ua", { ...PARAMS, buyTime: 1 });
        expect(sensor._entry("ev-42").uniqueDedupe.windowMs).toBe(RATE_DEDUPE_MS); // nunca menor que la de llegadas

        await sensor.observe("ev-42", "a|ua", { ...PARAMS, buyTime: 0 });
        expect(sensor._entry("ev-42").uniqueDedupe.windowMs).toBe(600_000);
    });

    it("sin llegadas nuevas manda n=0 igual: la respuesta refresca el estado", async () => {
        const { fetchImpl, lines } = fakeTc();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += 1000;
        await sensor.observe("ev-42", "a|ua", PARAMS); // deduplicado: n=0

        expect(lines).toHaveLength(2);
        expect(fields(lines[1].body).slice(3, 5)).toEqual(["0", "0"]);
    });
});

describe("createSensor — política de fallos", () => {
    it("TC sin estado para el evento todavía (null) → unknown, fail-open", async () => {
        const { fetchImpl } = fakeTc({ pending: true });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
    });

    it("token desconocido para el TC → active y error en el log (no apaga la protección)", async () => {
        const { fetchImpl } = fakeTc({ pending: true, rejected: { unknown_token: 1 } });
        const error = vi.fn();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger: { ...logger, error } });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("active");
        expect(error).toHaveBeenCalledTimes(1);

        // No una línea por tick: una por minuto.
        clock += 1000;
        await sensor.observe("ev-42", "b|ua", PARAMS);
        expect(error).toHaveBeenCalledTimes(1);
        clock += 60_000;
        await sensor.observe("ev-42", "c|ua", PARAMS);
        expect(error).toHaveBeenCalledTimes(2);
    });

    it("otro rechazo (línea inválida) se loguea y no cambia el estado", async () => {
        const { fetchImpl } = fakeTc({ pending: true, rejected: { bad_event_id: 1 } });
        const warn = vi.fn();
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger: { ...logger, warn } });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
        expect(warn).toHaveBeenCalled();
    });

    it("TC inalcanzable sin estado previo → unknown (fail-open)", async () => {
        const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
    });

    it("500 sin estado previo → unknown", async () => {
        const { fetchImpl } = fakeTc({ status: 500 });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
    });

    it("TC caído → mantiene el último estado mientras no esté rancio", async () => {
        const tc = fakeTc({ state: "active" });
        const fetchImpl = vi.fn((...args) => tc.fetchImpl(...args));
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        fetchImpl.mockImplementation(async () => { throw new Error("timeout"); });

        clock += 30_000;
        expect(await sensor.observe("ev-42", "b|ua", PARAMS)).toBe("active");

        clock += 31_000; // > tcStaleMs desde el último estado bueno
        expect(await sensor.observe("ev-42", "c|ua", PARAMS)).toBe("unknown");
    });

    it("si falla el POST, los totales se vuelven a mandar en el próximo tick", async () => {
        const { fetchImpl, lines } = fakeTc({ status: 503 });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await sensor.observe("ev-42", "a|ua", PARAMS);
        clock += 1000;
        await sensor.observe("ev-42", "b|ua", PARAMS);

        expect(fields(lines[1].body).slice(3, 5)).toEqual(["2", "2"]);
    });

    it("una respuesta que no es JSON no rompe", async () => {
        const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
    });

    it("una excepción inesperada del tick no se propaga", async () => {
        const fetchImpl = vi.fn(() => { throw new TypeError("boom"); });
        const sensor = createSensor(CONFIG, { fetchImpl, now, logger });

        await expect(sensor.observe("ev-42", "a|ua", PARAMS)).resolves.toBe("unknown");
    });

    it("el timeout del sensor corta la espera", async () => {
        const fetchImpl = vi.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
        const sensor = createSensor({ ...CONFIG, tcTimeoutMs: 20 }, { fetchImpl, now, logger });

        expect(await sensor.observe("ev-42", "a|ua", PARAMS)).toBe("unknown");
    });
});
