import { describe, it, expect, afterEach } from "vitest";
import { logPhase, phase, setCpuClock } from "../src/timing.js";

function recorder() {
    const lines = [];
    return { lines, log: (line) => lines.push(line) };
}

function clock(start = 1_000) {
    let t = start;
    return { read: () => t, advance: (ms) => { t += ms; } };
}

afterEach(() => setCpuClock(null));

describe("timing — formato", () => {
    it("sin reloj de CPU deja el formato de siempre", () => {
        const logger = recorder();
        logPhase(logger, "settings", 1483.4, "ok");
        expect(logger.lines).toEqual(["[timing] settings 1483ms ok"]);
    });

    it("con CPU la pone antes del resultado, que es texto libre", () => {
        const logger = recorder();
        logPhase(logger, "settings", 1800, "fetch failed: The operation was aborted", 130.6);
        expect(logger.lines).toEqual(["[timing] settings 1800ms cpu=131ms fetch failed: The operation was aborted"]);
    });

    it("sin resultado no deja un espacio colgando", () => {
        const logger = recorder();
        logPhase(logger, "config", 12, undefined, 3);
        expect(logger.lines).toEqual(["[timing] config 12ms cpu=3ms"]);
    });
});

describe("timing — phase", () => {
    it("mide pared y CPU de la fase cuando hay reloj de CPU", () => {
        const wall = clock(50_000);
        const cpu = clock(200);
        setCpuClock(cpu.read);

        const logger = recorder();
        const done = phase(logger, "settings", wall.read);
        wall.advance(1800);
        cpu.advance(129);
        done("ok");

        expect(logger.lines).toEqual(["[timing] settings 1800ms cpu=129ms ok"]);
    });

    it("sin reloj de CPU no inventa un cpu=0", () => {
        const wall = clock();
        const logger = recorder();
        const done = phase(logger, "verify", wall.read);
        wall.advance(600);
        done("ok");

        expect(logger.lines).toEqual(["[timing] verify 600ms ok"]);
    });

    it("un reloj de CPU que falla se ignora y la fase igual se loguea", () => {
        setCpuClock(() => {
            throw new Error("no disponible");
        });
        const wall = clock();
        const logger = recorder();
        const done = phase(logger, "decide", wall.read);
        wall.advance(20);
        done("allow");

        expect(logger.lines).toEqual(["[timing] decide 20ms allow"]);
    });

    it("loguea con el logger del cierre si se lo pasan", () => {
        const wall = clock();
        const early = recorder();
        const late = recorder();
        const done = phase(early, "config", wall.read);
        wall.advance(400);
        done("secret", late);

        expect(early.lines).toEqual([]);
        expect(late.lines).toEqual(["[timing] config 400ms secret"]);
    });
});
