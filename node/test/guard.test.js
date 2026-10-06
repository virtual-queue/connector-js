import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQueueGuard, fromNodeRequest } from "../src/guard.js";
import { parseCookies, serializeCookie } from "../src/cookies.js";
import { _resetSettingsCache } from "@vqueue/connector-core";

const SECRET = "test-private-key-abc123";
// Pase firmado por la implementación Elixir real (ver core/test/pass.test.js).
const ELIXIR_PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";

const SETTINGS_BODY = {
    success: true,
    data: {
        client: "orome",
        queue_url: "https://orome.virtual-queue.com",
        cookie_lifetime: 600,
        acls: [
            {
                action: "redirect_to_queue",
                pattern: "/shop",
                pattern_type: "prefix",
                event_id: "ev-42",
                priority: 0,
                enabled: true,
            },
        ],
    },
};

function guard(overrides = {}) {
    return createQueueGuard({
        client: "orome",
        privateKey: SECRET,
        adminHost: "admin.test",
        logger: { log() { }, warn() { }, error() { } },
        ...overrides,
    });
}

// Doble mínimo de http.IncomingMessage / ServerResponse.
function nodeReq({ url = "/shop/entradas", method = "GET", cookie, upgrade } = {}) {
    const headers = { host: "shop.test" };
    if (cookie) headers.cookie = cookie;
    if (upgrade) headers.upgrade = upgrade;
    return { url, method, headers };
}

function nodeRes() {
    const headers = {};
    return {
        statusCode: null,
        ended: false,
        writeHead(status, h) {
            this.statusCode = status;
            Object.assign(headers, h);
            return this;
        },
        end() {
            this.ended = true;
        },
        getHeader: (name) => headers[name],
        setHeader: (name, value) => {
            headers[name] = value;
        },
        _headers: headers,
    };
}

beforeEach(() => {
    _resetSettingsCache();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
        if (String(url).includes("/adapter/")) {
            return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false }), { status: 400 });
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("fromNodeRequest", () => {
    it("traduce un IncomingMessage al request del core", () => {
        const req = fromNodeRequest(nodeReq({ url: "/shop/entradas?sku=7" }));

        expect(req.host).toBe("shop.test");
        expect(req.path).toBe("/shop/entradas");
        expect(req.query.get("sku")).toBe("7");
        expect(req.method).toBe("GET");
    });

    it("prefiere x-forwarded-host (la app suele estar detrás de un proxy)", () => {
        const raw = nodeReq();
        raw.headers["x-forwarded-host"] = "tienda.cliente.com";

        expect(fromNodeRequest(raw).host).toBe("tienda.cliente.com");
    });

    it("saca el puerto y normaliza a minúsculas", () => {
        const raw = nodeReq();
        raw.headers.host = "Shop.Test:8443";

        expect(fromNodeRequest(raw).host).toBe("shop.test");
    });

    it("detecta el upgrade de WebSocket sin importar mayúsculas", () => {
        expect(fromNodeRequest(nodeReq({ upgrade: "WebSocket" })).isWebsocket).toBe(true);
    });
});

describe("guard — decisiones", () => {
    it("manda a la cola al visitante sin pase", async () => {
        const g = guard();
        const decision = await g.check(fromNodeRequest(nodeReq()));

        expect(decision.type).toBe("redirect");
        expect(decision.location).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("deja pasar al que tiene pase válido", async () => {
        const g = guard();
        const decision = await g.check(
            fromNodeRequest(nodeReq({ cookie: `vq_pass_ev-42=${ELIXIR_PASS}` })),
        );

        expect(decision.type).toBe("allow");
        expect(decision.renew).toBeDefined();
    });

    it("saltea assets sin tocar la red", async () => {
        const g = guard();
        const decision = await g.check(fromNodeRequest(nodeReq({ url: "/shop/app.css" })));

        expect(decision.type).toBe("bypass");
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("sin config válida no encola a nadie", async () => {
        vi.spyOn(console, "error").mockImplementation(() => { });
        const g = createQueueGuard({ client: "orome", privateKey: "" });

        expect((await g.check(fromNodeRequest(nodeReq()))).type).toBe("allow");
    });

    it("si la API se cae, deja pasar", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
        const g = guard();

        expect((await g.check(fromNodeRequest(nodeReq()))).type).toBe("allow");
    });
});

describe("guard — aplica sobre la respuesta", () => {
    it("responde 302 y corta la cadena", async () => {
        const g = guard();
        const res = nodeRes();

        const handled = g.apply(
            { type: "redirect", location: "https://cola/queue/ev-42", cookies: [] },
            res,
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(302);
        expect(res._headers.Location).toBe("https://cola/queue/ev-42");
        expect(res._headers["Cache-Control"]).toBe("no-store");
        expect(res.ended).toBe(true);
    });

    it("renueva el pase sin cortar la cadena", async () => {
        const g = guard();
        const res = nodeRes();

        const handled = g.apply(
            { type: "allow", renew: { name: "vq_pass_ev-42", value: "x", maxAge: 600 } },
            res,
        );

        expect(handled).toBe(false);
        expect(res.getHeader("Set-Cookie")[0]).toContain("vq_pass_ev-42=x");
    });

    it("no pisa las cookies que ya puso la app del cliente", async () => {
        const g = guard();
        const res = nodeRes();
        res.setHeader("Set-Cookie", ["session=abc"]);

        g.apply({ type: "allow", renew: { name: "vq_pass_ev-42", value: "x", maxAge: 600 } }, res);

        expect(res.getHeader("Set-Cookie")).toHaveLength(2);
        expect(res.getHeader("Set-Cookie")[0]).toBe("session=abc");
    });
});

describe("guard — middleware de Express", () => {
    it("llama a next() cuando el visitante pasa", async () => {
        const g = guard();
        const next = vi.fn();
        const res = nodeRes();

        await g.express()(nodeReq({ cookie: `vq_pass_ev-42=${ELIXIR_PASS}` }), res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.ended).toBe(false);
    });

    it("NO llama a next() cuando redirige a la cola", async () => {
        const g = guard();
        const next = vi.fn();
        const res = nodeRes();

        await g.express()(nodeReq(), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(302);
    });
});

describe("guard — hook de Fastify", () => {
    // Doble mínimo de `reply`: acumula set-cookie como hace Fastify.
    function fastifyReply() {
        const headers = {};
        return {
            headers,
            redirected: null,
            header(name, value) {
                if (name === "set-cookie") headers[name] = [...(headers[name] ?? []), value];
                else headers[name] = value;
                return this;
            },
            redirect(url, status) {
                this.redirected = { url, status };
                return this;
            },
        };
    }

    it("redirige con la API de reply y corta la cadena", async () => {
        const g = guard();
        const reply = fastifyReply();

        const result = await g.fastify()({ raw: nodeReq() }, reply);

        expect(result).toBe(reply);
        expect(reply.redirected).toEqual({ url: "https://orome.virtual-queue.com/queue/ev-42", status: 302 });
        expect(reply.headers["set-cookie"][0]).toContain("vq_target_ev-42=");
    });

    it("renueva el pase por reply.header y sigue la cadena", async () => {
        const g = guard();
        const reply = fastifyReply();

        const result = await g.fastify()({ raw: nodeReq({ cookie: `vq_pass_ev-42=${ELIXIR_PASS}` }) }, reply);

        expect(result).toBeUndefined();
        expect(reply.headers["set-cookie"][0]).toContain(`vq_pass_ev-42=${ELIXIR_PASS}`);
    });
});

describe("guard — robustez", () => {
    it("se puede desestructurar sin perder `this`", async () => {
        const { express, fastify } = guard();
        const next = vi.fn();

        await express()(nodeReq({ cookie: `vq_pass_ev-42=${ELIXIR_PASS}` }), nodeRes(), next);

        expect(next).toHaveBeenCalledOnce();
        expect(typeof fastify()).toBe("function");
    });

    it("un request intraducible no cuelga Express: fail-open y next()", async () => {
        const g = guard();
        const next = vi.fn();

        // `new URL` lanza con este host; Express 4 no captura rechazos async.
        await g.express()(nodeReq({ url: "http://[::1" }), nodeRes(), next);

        expect(next).toHaveBeenCalledOnce();
    });

    it("un client undefined explícito cae al entorno igual que si no viniera", () => {
        vi.stubEnv("VQUEUE_CLIENT", "desde-env");
        vi.spyOn(console, "error").mockImplementation(() => { });

        const g = createQueueGuard({ client: undefined, privateKey: SECRET, logger: { error() { } } });

        expect(g.config.client).toBe("desde-env");
        vi.unstubAllEnvs();
    });
});

describe("cookies", () => {
    it("tolera un valor con '=' adentro (base64url del pase)", () => {
        expect(parseCookies("vq_pass_ev-42=abc.def==")["vq_pass_ev-42"]).toBe("abc.def==");
    });

    it("serializa percent-encoded y parsea decodificando: un ';' no corta el destino", () => {
        const written = serializeCookie({ name: "vq_target_ev-42", value: "/shop/a;b?x=1", maxAge: 60 });
        const value = written.split(";")[0].split("=").slice(1).join("=");

        expect(value).toBe("%2Fshop%2Fa%3Bb%3Fx%3D1");
        expect(parseCookies(`vq_target_ev-42=${value}`)["vq_target_ev-42"]).toBe("/shop/a;b?x=1");
    });

    it("una cookie ajena con % inválido se devuelve cruda, sin lanzar", () => {
        expect(parseCookies("ajena=100%").ajena).toBe("100%");
    });

    it("el pase va HttpOnly y Secure", () => {
        const value = serializeCookie({ name: "vq_pass_ev-42", value: "x", maxAge: 600 });

        expect(value).toContain("HttpOnly");
        expect(value).toContain("Secure");
        expect(value).toContain("SameSite=Lax");
    });

    it("permite desactivar Secure para desarrollo en http://localhost", () => {
        const value = serializeCookie({ name: "p", value: "x", maxAge: 600 }, { secure: false });
        expect(value).not.toContain("Secure");
    });
});
