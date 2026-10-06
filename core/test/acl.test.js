import { describe, it, expect } from "vitest";
import { matchRule, sortRules, findMatch, ASSET_REGEX } from "../src/acl.js";

describe("acl — matcheo", () => {
    it("un pattern vacío no matchea nada, en ningún tipo", () => {
        // startsWith("") e includes("") son true para cualquier path: una regla
        // mal cargada encolaría el sitio entero.
        for (const type of ["prefix", "exact", "contains", "glob"]) {
            expect(matchRule({ pattern: "", pattern_type: type }, "/shop")).toBe(false);
        }
    });

    it("el glob no trata el punto como metacaracter", () => {
        const rule = { pattern: "/shop/*.html", pattern_type: "glob" };
        expect(matchRule(rule, "/shop/entradas.html")).toBe(true);
        expect(matchRule(rule, "/shop/entradasXhtml")).toBe(false);
    });

    it("un pattern_type desconocido no matchea", () => {
        expect(matchRule({ pattern: "/shop", pattern_type: "regex" }, "/shop")).toBe(false);
    });

    it("ordena por prioridad y las reglas sin prioridad van al final", () => {
        const rules = sortRules([
            { action: "a", pattern: "/x", pattern_type: "prefix", enabled: true },
            { action: "b", pattern: "/x", pattern_type: "prefix", priority: 5, enabled: true },
            { action: "c", pattern: "/x", pattern_type: "prefix", priority: 1, enabled: false },
        ]);

        expect(rules.map((r) => r.action)).toEqual(["b", "a"]);
        expect(findMatch(rules, "/x")).toMatchObject({ action: "b" });
    });

    it(".json no es asset, el resto sí", () => {
        expect(ASSET_REGEX.test("/shop/products.json")).toBe(false);
        expect(ASSET_REGEX.test("/shop/app.css")).toBe(true);
        expect(ASSET_REGEX.test("/img/foto.AVIF")).toBe(true);
    });
});
