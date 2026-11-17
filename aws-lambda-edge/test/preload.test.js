import { describe, it, expect } from "vitest";
import { preloadFetch } from "../src/preload.js";

describe("preloadFetch", () => {
    it("deja cargado el fetch de Node", () => {
        expect(preloadFetch()).toBe(true);
        expect(new Headers({ accept: "application/json" }).get("accept")).toBe("application/json");
    });

    it("se puede llamar de nuevo sin costo ni error", () => {
        expect(preloadFetch()).toBe(true);
        expect(preloadFetch()).toBe(true);
    });
});
