import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// vendor/ es una copia de core/src (ver scripts/sync-core.mjs). Si core cambia y
// la copia no, este test falla: así una corrección de ACLs o del pase nunca llega
// al Worker "después" sin que nadie se entere.
const core = fileURLToPath(new URL("../../core/src/", import.meta.url));
const vendor = fileURLToPath(new URL("../vendor/", import.meta.url));

describe("vendor/ está sincronizado con core/src", () => {
    it("tiene los mismos archivos", () => {
        expect(readdirSync(vendor).sort()).toEqual(readdirSync(core).sort());
    });

    for (const file of readdirSync(core)) {
        it(`${file} es idéntico`, () => {
            expect(readFileSync(vendor + file, "utf8")).toBe(readFileSync(core + file, "utf8"));
        });
    }
});
