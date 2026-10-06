import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPass, hasValidPassFor, passCookieName } from "../src/pass.js";

// ─────────────────────────────────────────────────────────────────────────────
// VECTOR DE INTEROPERABILIDAD
//
// Este pase NO lo generó este código: lo firmó la implementación Elixir real
// (VQueue.Lines.QueuePass.sign/4) ejecutada contra las deps del admin. Si alguien
// cambia el formato de un lado, este test se cae — que es exactamente para lo que
// está. Es la única garantía de que el conector valida pases genuinos de VQueue.
//
//   secret:   "test-private-key-abc123"
//   iat/exp:  1700000000 / 1700003600
//   evento:   "ev-42"
// ─────────────────────────────────────────────────────────────────────────────
const ELIXIR_PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";
const SECRET = "test-private-key-abc123";
const BEFORE_EXP = 1_700_000_100;
const AFTER_EXP = 1_700_003_601;

describe("QueuePass — interoperabilidad con la implementación Elixir", () => {
    it("acepta un pase firmado por VQueue", () => {
        const result = verifyPass(ELIXIR_PASS, SECRET, BEFORE_EXP);

        expect(result.ok).toBe(true);
        expect(result.payload.e).toBe("ev-42");
        expect(result.payload.t).toBe("11111111-1111-1111-1111-111111111111");
        expect(result.payload.exp).toBe(1_700_003_600);
    });

    it("lo rechaza cuando venció", () => {
        expect(verifyPass(ELIXIR_PASS, SECRET, AFTER_EXP)).toEqual({ ok: false, reason: "expired" });
    });

    it("lo rechaza con otro secreto", () => {
        expect(verifyPass(ELIXIR_PASS, "otro-secreto", BEFORE_EXP))
            .toEqual({ ok: false, reason: "bad_signature" });
    });
});

describe("QueuePass — manipulación", () => {
    it("rechaza un payload alterado (aunque se conserve la firma)", () => {
        const [encoded, sig] = ELIXIR_PASS.split(".");
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

        // Extender el vencimiento 10 años: la firma deja de cerrar.
        payload.exp = 2_000_000_000;
        const forged = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

        expect(verifyPass(`${forged}.${sig}`, SECRET, BEFORE_EXP))
            .toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rechaza una firma recortada", () => {
        const [encoded, sig] = ELIXIR_PASS.split(".");
        expect(verifyPass(`${encoded}.${sig.slice(0, -1)}`, SECRET, BEFORE_EXP))
            .toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rechaza formatos rotos sin lanzar", () => {
        for (const bad of ["", "sin-punto", ".solo-firma", "solo-payload.", "a.b.c", null, undefined, 42]) {
            const result = verifyPass(bad, SECRET, BEFORE_EXP);
            expect(result.ok).toBe(false);
        }
    });

    it("rechaza un payload bien firmado pero sin exp", () => {
        const encoded = Buffer.from(JSON.stringify({ t: "x", e: "ev-42" }), "utf8").toString("base64url");
        const sig = createHmac("sha256", SECRET).update(encoded).digest("base64url");

        expect(verifyPass(`${encoded}.${sig}`, SECRET, BEFORE_EXP))
            .toEqual({ ok: false, reason: "malformed" });
    });

    it("sin secreto no valida nada", () => {
        expect(verifyPass(ELIXIR_PASS, "", BEFORE_EXP)).toEqual({ ok: false, reason: "malformed" });
    });
});

describe("QueuePass — pase por evento", () => {
    it("acepta el pase del evento consultado", () => {
        const cookies = { [passCookieName("ev-42")]: ELIXIR_PASS };
        expect(hasValidPassFor(cookies, "ev-42", SECRET, BEFORE_EXP).ok).toBe(true);
    });

    it("no admite al evento B con el pase del evento A", () => {
        // La cookie del evento B contiene un pase válido... pero de otro evento.
        const cookies = { [passCookieName("ev-99")]: ELIXIR_PASS };

        expect(hasValidPassFor(cookies, "ev-99", SECRET, BEFORE_EXP))
            .toEqual({ ok: false, reason: "event_mismatch" });
    });

    it("informa cuando no hay cookie", () => {
        expect(hasValidPassFor({}, "ev-42", SECRET, BEFORE_EXP))
            .toEqual({ ok: false, reason: "absent" });
    });
});
