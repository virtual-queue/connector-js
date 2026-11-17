import { describe, it, expect, vi, afterEach } from "vitest";
import { warmUp } from "../src/warmup.js";

afterEach(() => vi.useRealTimers());

describe("warmUp", () => {
    it("devuelve lo que devuelve el trabajo si termina a tiempo", async () => {
        await expect(warmUp(async () => "ok", { budgetMs: 1_000 })).resolves.toBe("ok");
    });

    it("pasado el tope sigue sin esperar al trabajo, que queda en vuelo", async () => {
        vi.useFakeTimers();
        let finished = false;
        const work = () => new Promise((resolve) => setTimeout(() => { finished = true; resolve("ok"); }, 5_000));

        const outcome = warmUp(work, { budgetMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(outcome).resolves.toBe("budget");
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(finished).toBe(true);
    });

    it("nunca rechaza: un trabajo que falla devuelve error", async () => {
        await expect(warmUp(async () => { throw new Error("Secrets Manager caído"); })).resolves.toBe("error");
        await expect(warmUp(() => { throw new Error("sincrónico"); })).resolves.toBe("error");
    });

    it("un trabajo que falla después del tope no deja un rechazo sin manejar", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const work = () => new Promise((_, reject) => setTimeout(() => reject(new Error("tarde")), 2_000));
            const outcome = warmUp(work, { budgetMs: 500 });
            await vi.advanceTimersByTimeAsync(500);
            await expect(outcome).resolves.toBe("budget");
            await vi.advanceTimersByTimeAsync(2_000);
            await new Promise((resolve) => setImmediate(resolve));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });
});
