import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetSettingsCache } from "@vqueue/connector-core/settings";

// Bundle SIN configurar (el que instala el botón de CloudFormation): la config
// horneada son los placeholders y la real sale de Secrets Manager.
const SECRET = "test-private-key-abc123";
const ELIXIR_PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";

vi.mock("../src/generated-config.js", () => ({
    CONFIG: {
        client: "__VQ_CLIENT__",
        privateKey: "__VQ_PRIVATE_KEY__",
        adminHost: "admin.test",
        settingsTtlMs: 30000,
        settingsTimeoutMs: 1500,
        verifyTimeoutMs: 2000,
        debug: false,
    },
}));

// Secrets Manager se simula a nivel de fetch: es lo que el conector llama de verdad.
const secretsCalls = vi.fn();
let secretResponse;

const SETTINGS_BODY = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [{ action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true }],
    },
};

const event = (cookie) => ({
    Records: [{
        cf: {
            request: {
                uri: "/shop/entradas",
                querystring: "",
                method: "GET",
                headers: {
                    host: [{ key: "host", value: "shop.test" }],
                    ...(cookie ? { cookie: [{ key: "cookie", value: cookie }] } : {}),
                },
            },
        },
    }],
});

beforeEach(() => {
    vi.resetModules();
    _resetSettingsCache();
    secretsCalls.mockReset();
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKID");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_SESSION_TOKEN", "tok");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
        if (String(url).includes("secretsmanager.")) {
            secretsCalls();
            return secretResponse();
        }
        return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

const secretOk = (over = {}) => () =>
    new Response(JSON.stringify({ SecretString: JSON.stringify({ client: "orome", privateKey: SECRET, ...over }) }), { status: 200 });

describe("viewer-request con la config en Secrets Manager", () => {
    it("lee el secreto y encola al visitante sin pase", async () => {
        secretResponse = secretOk();

        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event());

        expect(res.status).toBe("302");
        expect(res.headers.location[0].value).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("valida el pase con la clave del secreto", async () => {
        secretResponse = secretOk();

        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event(`vq_pass_ev-42=${ELIXIR_PASS}`));

        expect(res.uri).toBe("/shop/entradas"); // pasa al origin
        expect(res.headers["x-vq-renew"]).toBeDefined();
    });

    it("lee el secreto una sola vez por contenedor", async () => {
        secretResponse = secretOk();

        const { handler } = await import("../src/viewer-request/index.js");
        await handler(event());
        await handler(event());

        expect(secretsCalls).toHaveBeenCalledTimes(1);
    });

    it("si el secreto no se puede leer, deja pasar (fail-open)", async () => {
        secretResponse = () => new Response("{\"__type\":\"AccessDeniedException\"}", { status: 400 });

        const { handler } = await import("../src/viewer-request/index.js");
        const res = await handler(event());

        expect(res.uri).toBe("/shop/entradas"); // request, no 302
    });
});
