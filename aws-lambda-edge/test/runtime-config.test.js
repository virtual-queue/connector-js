import { describe, it, expect, vi } from "vitest";
import { createConfigProvider, fetchSecretFromSecretsManager, signV4, SECRET_NAME } from "../src/runtime-config.js";

const PLACEHOLDERS = {
    client: "__VQ_CLIENT__",
    privateKey: "__VQ_PRIVATE_KEY__",
    adminHost: "clients.virtual-queue.com",
    verifyTimeoutMs: 2000,
};
const BAKED = { ...PLACEHOLDERS, client: "orome", privateKey: "k" };
const secret = (over = {}) => JSON.stringify({ client: "orome", privateKey: "clave", ...over });
const quiet = { error: vi.fn() };

function clock(t = 1_000_000) {
    return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("runtime-config", () => {
    it("con config horneada válida no toca Secrets Manager", async () => {
        const fetchSecret = vi.fn();
        const config = await createConfigProvider(BAKED, { fetchSecret, logger: quiet })();

        expect(config).toBe(BAKED);
        expect(fetchSecret).not.toHaveBeenCalled();
    });

    it("con el bundle sin configurar lee el secreto y lo mezcla con los defaults", async () => {
        const fetchSecret = vi.fn(async () => secret());
        const config = await createConfigProvider(PLACEHOLDERS, { fetchSecret, logger: quiet })();

        expect(config).toMatchObject({ client: "orome", privateKey: "clave", adminHost: "clients.virtual-queue.com", verifyTimeoutMs: 2000 });
    });

    it("el secreto puede traer su propio adminHost", async () => {
        const fetchSecret = vi.fn(async () => secret({ adminHost: "admin.staging.test" }));
        const config = await createConfigProvider(PLACEHOLDERS, { fetchSecret, logger: quiet })();

        expect(config.adminHost).toBe("admin.staging.test");
    });

    it("cachea: no va a Secrets Manager en cada request", async () => {
        const c = clock();
        const fetchSecret = vi.fn(async () => secret());
        const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret, now: c.now, logger: quiet });

        await getConfig();
        await getConfig();
        expect(fetchSecret).toHaveBeenCalledTimes(1);
    });

    it("las cargas concurrentes comparten una sola llamada", async () => {
        const fetchSecret = vi.fn(async () => secret());
        const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret, logger: quiet });

        await Promise.all([getConfig(), getConfig(), getConfig()]);
        expect(fetchSecret).toHaveBeenCalledTimes(1);
    });

    it("una clave rotada se toma al vencer el cache", async () => {
        const c = clock();
        let key = "vieja";
        const fetchSecret = vi.fn(async () => secret({ privateKey: key }));
        const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret, now: c.now, logger: quiet });

        expect((await getConfig()).privateKey).toBe("vieja");
        key = "nueva";
        c.advance(300_001);
        expect((await getConfig()).privateKey).toBe("nueva");
    });

    it("sin secreto devuelve null (fail-open) y no martilla Secrets Manager", async () => {
        const c = clock();
        const fetchSecret = vi.fn(async () => { throw new Error("AccessDenied"); });
        const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret, now: c.now, logger: quiet });

        expect(await getConfig()).toBeNull();
        expect(await getConfig()).toBeNull();
        expect(fetchSecret).toHaveBeenCalledTimes(1);

        c.advance(30_001);
        await getConfig();
        expect(fetchSecret).toHaveBeenCalledTimes(2);
        expect(quiet.error.mock.calls[0][0]).toContain(SECRET_NAME);
    });

    it("si el refresco falla sigue sirviendo la última config buena", async () => {
        const c = clock();
        let fail = false;
        const fetchSecret = vi.fn(async () => { if (fail) throw new Error("throttled"); return secret(); });
        const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret, now: c.now, logger: quiet });

        const first = await getConfig();
        fail = true;
        c.advance(300_001);

        expect(await getConfig()).toBe(first);
    });

    it("un secreto incompleto o con JSON roto es fail-open", async () => {
        for (const raw of ["no es json", JSON.stringify({ client: "orome" }), JSON.stringify({})]) {
            const getConfig = createConfigProvider(PLACEHOLDERS, { fetchSecret: async () => raw, logger: quiet });
            expect(await getConfig()).toBeNull();
        }
    });

    it("un secreto que todavía tiene los placeholders no se acepta", async () => {
        const fetchSecret = async () => secret({ privateKey: "__VQ_PRIVATE_KEY__" });
        expect(await createConfigProvider(PLACEHOLDERS, { fetchSecret, logger: quiet })()).toBeNull();
    });
});

// ─── Firma SigV4 ────────────────────────────────────────────────────────────
// Vector del ejemplo oficial de AWS ("Signature Version 4 signing process":
// ListUsers de IAM). Si la firma a mano se desvía un byte, AWS responde 403.
describe("signV4", () => {
    const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

    it("reproduce la firma del ejemplo documentado por AWS", () => {
        const headers = signV4(
            {
                method: "GET",
                host: "iam.amazonaws.com",
                path: "/",
                query: "Action=ListUsers&Version=2010-05-08",
                headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
                body: "",
                region: "us-east-1",
                service: "iam",
            },
            CREDS,
            new Date("2015-08-30T12:36:00Z"),
        );

        expect(headers.authorization).toBe(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
            "SignedHeaders=content-type;host;x-amz-date, " +
            "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
        );
        expect(headers["x-amz-date"]).toBe("20150830T123600Z");
        expect(headers.host).toBeUndefined(); // lo arma fetch a partir de la URL
    });

    it("con token de sesión lo firma y lo envía", () => {
        const headers = signV4(
            { method: "POST", host: "h.test", path: "/", query: "", headers: {}, body: "{}", region: "us-east-1", service: "x" },
            { ...CREDS, sessionToken: "TOKEN" },
            new Date("2015-08-30T12:36:00Z"),
        );

        expect(headers["x-amz-security-token"]).toBe("TOKEN");
        expect(headers.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
    });
});

describe("fetchSecretFromSecretsManager", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "tok" };
    const now = () => new Date("2026-10-06T12:00:00Z");

    it("hace un POST firmado al endpoint regional con el SecretId", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ SecretString: "{\"client\":\"x\"}" }), { status: 200 }));

        const value = await fetchSecretFromSecretsManager(undefined, { env, now, fetchImpl });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(value).toBe("{\"client\":\"x\"}");
        expect(url).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({ SecretId: SECRET_NAME });
        expect(init.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
        expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261006\/us-east-1\/secretsmanager\/aws4_request/);
    });

    it("sin credenciales en el entorno falla con un mensaje claro", async () => {
        await expect(fetchSecretFromSecretsManager(undefined, { env: {}, now, fetchImpl: vi.fn() }))
            .rejects.toThrow(/credenciales/);
    });

    it("un 400/403 de AWS incluye el motivo en el error", async () => {
        const fetchImpl = vi.fn(async () => new Response("{\"__type\":\"AccessDeniedException\"}", { status: 400 }));

        await expect(fetchSecretFromSecretsManager(undefined, { env, now, fetchImpl }))
            .rejects.toThrow(/400.*AccessDeniedException/);
    });
});
