import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decide, exchangeToken, safeTarget, targetCookieName, matchPath, _resetKeyMismatch } from "../src/decide.js";
import { validateConfig } from "../src/config.js";
import { sortRules } from "../src/acl.js";
import { passCookieName } from "../src/pass.js";

const SECRET = "test-private-key-abc123";
const ELIXIR_PASS =
    "eyJlIjoiZXYtNDIiLCJleHAiOjE3MDAwMDM2MDAsImlhdCI6MTcwMDAwMDAwMCwidCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9" +
    ".AjaVlbsXru7V8GOJuhEV2doxd3W1-dQlEVTi5BEnNco";

const CONFIG = { client: "orome", privateKey: SECRET };
// El token de la cola es el id de la línea: un UUID.
const TOKEN = "11111111-1111-1111-1111-111111111111";

const SETTINGS = {
    client: "orome",
    queueUrl: "https://orome.virtual-queue.com",
    cookieLifetime: 600,
    rules: sortRules([
        { action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: "ev-42", priority: 0, enabled: true },
        { action: "bypass", pattern: "/shop/ayuda", pattern_type: "exact", event_id: null, priority: -1, enabled: true },
    ]),
};

function req({ path = "/shop/entradas", query = "", cookies = {}, method = "GET", isWebsocket = false, isNavigation } = {}) {
    return { host: "shop.test", path, query: new URLSearchParams(query), cookies, method, isWebsocket, isNavigation };
}

function deps({ settings = SETTINGS, fetchImpl } = {}) {
    return {
        logger: { log: () => { }, warn: () => { }, error: () => { } },
        getSettings: async () => settings,
        fetchImpl,
    };
}

beforeEach(() => {
    // Dentro de la validez del pase del vector.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
});

afterEach(() => {
    vi.restoreAllMocks();
    _resetKeyMismatch();
});

describe("decide — bypass barato", () => {
    it("saltea assets sin pedir settings", async () => {
        const getSettings = vi.fn();
        const d = await decide(req({ path: "/shop/app.css" }), CONFIG, { ...deps(), getSettings });

        expect(d.type).toBe("bypass");
        expect(getSettings).not.toHaveBeenCalled();
    });

    it("no saltea .json (son endpoints dinámicos)", async () => {
        const d = await decide(req({ path: "/shop/products.json" }), CONFIG, deps());
        expect(d.type).toBe("redirect");
    });

    it("saltea websockets", async () => {
        expect((await decide(req({ isWebsocket: true }), CONFIG, deps())).type).toBe("bypass");
    });

    it("no redirige un POST (perdería el body del checkout)", async () => {
        expect((await decide(req({ method: "POST" }), CONFIG, deps())).type).toBe("bypass");
    });
});

describe("decide — ACLs", () => {
    it("manda a la cola si la regla matchea y no hay pase", async () => {
        const d = await decide(req(), CONFIG, deps());

        expect(d.type).toBe("redirect");
        expect(d.location).toBe("https://orome.virtual-queue.com/queue/ev-42");
    });

    it("guarda el destino para poder volver después", async () => {
        const d = await decide(req({ path: "/shop/entradas", query: "fila=3" }), CONFIG, deps());

        const target = d.cookies.find((c) => c.name === targetCookieName("ev-42"));
        expect(target.value).toBe("/shop/entradas?fila=3");
    });

    it("una regla bypass de mayor prioridad gana sobre el redirect", async () => {
        const d = await decide(req({ path: "/shop/ayuda" }), CONFIG, deps());
        expect(d.type).toBe("allow");
    });

    it("sin regla que matchee, pasa", async () => {
        expect((await decide(req({ path: "/nada" }), CONFIG, deps())).type).toBe("allow");
    });

    it("una regla sin event_id no encola a nadie", async () => {
        const settings = { ...SETTINGS, rules: sortRules([
            { action: "redirect_to_queue", pattern: "/shop", pattern_type: "prefix", event_id: null, priority: 0, enabled: true },
        ]) };

        expect((await decide(req(), CONFIG, deps({ settings }))).type).toBe("allow");
    });
});

describe("decide — pase", () => {
    it("con pase válido pasa y lo renueva", async () => {
        const cookies = { [passCookieName("ev-42")]: ELIXIR_PASS };
        const d = await decide(req({ cookies }), CONFIG, deps());

        expect(d.type).toBe("allow");
        expect(d.renew).toEqual({ name: "vq_pass_ev-42", value: ELIXIR_PASS, maxAge: 600 });
    });

    it("con pase vencido vuelve a la cola", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_700_003_601_000);
        const cookies = { [passCookieName("ev-42")]: ELIXIR_PASS };

        expect((await decide(req({ cookies }), CONFIG, deps())).type).toBe("redirect");
    });

    it("con pase falsificado vuelve a la cola", async () => {
        const cookies = { [passCookieName("ev-42")]: "falsificado.nope" };
        expect((await decide(req({ cookies }), CONFIG, deps())).type).toBe("redirect");
    });
});

describe("decide — fail-open", () => {
    it("sin settings deja pasar", async () => {
        const d = await decide(req(), CONFIG, { ...deps(), getSettings: async () => null });
        expect(d.type).toBe("allow");
    });
});

describe("decide — canje del token", () => {
    const verifyOk = () =>
        vi.fn(async () => new Response(
            JSON.stringify({ success: true, data: { event_id: "ev-42", pass: ELIXIR_PASS, pass_ttl: 3600 } }),
            { status: 200 },
        ));

    it("canjea el token, emite el pase y limpia la query", async () => {
        const d = await decide(
            req({ path: "/shop/entradas", query: `token=${TOKEN}&sku=7` }),
            CONFIG,
            deps({ fetchImpl: verifyOk() }),
        );

        expect(d.type).toBe("redirect");
        expect(d.location).toBe("/shop/entradas?sku=7"); // conserva sku, saca token
        expect(d.cookies.find((c) => c.name === "vq_pass_ev-42").value).toBe(ELIXIR_PASS);
    });

    it("vuelve al destino guardado antes de ir a la cola", async () => {
        const cookies = { [targetCookieName("ev-42")]: "/shop/entradas?fila=3" };
        const d = await decide(
            req({ path: "/", query: `token=${TOKEN}`, cookies }),
            CONFIG,
            deps({ fetchImpl: verifyOk() }),
        );

        expect(d.location).toBe("/shop/entradas?fila=3");
    });

    it("un ?token= que no es de la cola NO se secuestra: sigue el flujo normal", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 400 }));

        // /reset no matchea ninguna ACL → tiene que pasar al origen con su token intacto.
        const d = await decide(req({ path: "/reset", query: `token=${TOKEN}` }), CONFIG, deps({ fetchImpl }));

        expect(d.type).toBe("allow");
    });

    it("un ?token= que no es UUID ni siquiera toca la red", async () => {
        // Un magic link propio del sitio no puede costar un round trip a VQueue
        // por página, ni servir para que cualquiera haga golpear la API.
        const fetchImpl = vi.fn();

        const d = await decide(req({ path: "/reset", query: "token=abc123" }), CONFIG, deps({ fetchImpl }));

        expect(d.type).toBe("allow");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("sin pase en la respuesta del verify, el canje se considera fallido", async () => {
        // Escribir el token crudo como pase produciría una cookie que nunca
        // valida: el visitante volvería a la cola en la página siguiente.
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ success: true, data: { event_id: "ev-42", pass: null, token: TOKEN } }),
            { status: 200 },
        ));

        const d = await decide(req({ query: `vq_token=${TOKEN}` }), CONFIG, deps({ fetchImpl }));

        expect(d.type).toBe("redirect");
        expect(d.location).toContain("/queue/ev-42");
        expect(d.cookies.some((c) => c.name === "vq_pass_ev-42")).toBe(false);
    });

    it("un verify que redirecciona es un problema nuestro: deja pasar", async () => {
        const fetchImpl = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { location: "https://loop" },
        }));

        const d = await decide(req({ query: `token=${TOKEN}` }), CONFIG, deps({ fetchImpl }));

        expect(d.type).toBe("allow");
    });

    it("si VQueue responde 5xx o no responde, el que vuelve de la fila pasa", async () => {
        for (const fetchImpl of [
            vi.fn(async () => new Response("boom", { status: 503 })),
            vi.fn(async () => { throw new Error("timeout"); }),
            vi.fn(async () => new Response("<html>challenge</html>", { status: 200 })),
        ]) {
            const d = await decide(req({ query: `vq_token=${TOKEN}` }), CONFIG, deps({ fetchImpl }));
            expect(d.type).toBe("allow");
        }
    });

    it("un 4xx de verify (token ya usado) sigue el flujo normal", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 400 }));
        const d = await decide(req({ query: `vq_token=${TOKEN}` }), CONFIG, deps({ fetchImpl }));
        expect(d.location).toContain("/queue/ev-42");
    });

    it("con la privateKey equivocada no hay loop: deja de encolar y lo avisa", async () => {
        const error = vi.fn();
        const wrong = { ...CONFIG, privateKey: "otra-clave" };
        const d = await decide(req({ query: `vq_token=${TOKEN}` }), wrong, { ...deps({ fetchImpl: verifyOk() }), logger: { log() { }, warn() { }, error } });

        expect(d.type).toBe("redirect");
        expect(d.location).toBe("/shop/entradas");
        expect(d.cookies.some((c) => c.name === "vq_pass_ev-42")).toBe(false);
        expect(error).toHaveBeenCalled();

        // La siguiente página protegida pasa en vez de volver a la cola.
        const next = await decide(req(), wrong, deps());
        expect(next.type).toBe("allow");
        // Con la clave correcta se sigue encolando normalmente.
        expect((await decide(req(), CONFIG, deps())).type).toBe("redirect");
    });

    it("el path actual como destino tampoco abre un open redirect", async () => {
        for (const path of ["//evil.com", "/\\evil.com"]) {
            const d = await decide(req({ path, query: `vq_token=${TOKEN}` }), CONFIG, deps({ fetchImpl: verifyOk() }));
            expect(d.location).toBe("/");
        }
    });

    it("exchangeToken distingue \"no se pudo preguntar\" de \"no es un token\"", async () => {
        const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
        expect(await exchangeToken(TOKEN, SETTINGS, { fetchImpl: down, logger: { warn: () => { } } })).toEqual({ unavailable: true });

        const rejected = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 400 }));
        expect(await exchangeToken(TOKEN, SETTINGS, { fetchImpl: rejected, logger: { log: () => { } } })).toBeNull();
    });
});

describe("safeTarget — no abrir un open redirect", () => {
    it("acepta paths propios", () => {
        expect(safeTarget("/shop/entradas?fila=3")).toBe("/shop/entradas?fila=3");
    });

    it("rechaza URLs absolutas y protocol-relative", () => {
        expect(safeTarget("https://malicioso.com")).toBeNull();
        expect(safeTarget("//malicioso.com")).toBeNull();
        expect(safeTarget("http://malicioso.com")).toBeNull();
        // Los browsers tratan "/\\host" como "//host".
        expect(safeTarget("/\\malicioso.com")).toBeNull();
    });

    it("rechaza CRLF (header injection)", () => {
        expect(safeTarget("/ok\r\nSet-Cookie: x=1")).toBeNull();
    });

    it("rechaza tabs y otros caracteres de control (\"/\\t/host\" termina en \"//host\")", () => {
        expect(safeTarget("/\t/evil.com")).toBeNull();
        expect(safeTarget("/ok\u0000")).toBeNull();
    });

    it("rechaza basura", () => {
        expect(safeTarget("")).toBeNull();
        expect(safeTarget(null)).toBeNull();
        expect(safeTarget("relativo")).toBeNull();
    });
});

describe("matchPath — las reglas ven lo mismo que el origen", () => {
    it("decodifica percent-encoding", () => {
        expect(matchPath("/%73hop/entradas")).toBe("/shop/entradas");
    });

    it("saca parámetros de segmento", () => {
        expect(matchPath("/shop/checkout;x.css")).toBe("/shop/checkout");
        expect(matchPath("/shop;jsessionid=abc/entradas")).toBe("/shop/entradas");
    });

    it("un encoding inválido no rompe", () => {
        expect(matchPath("/shop/%E0%A4%A")).toBe("/shop/%E0%A4%A");
    });

    it("una regla sobre /shop atrapa /%73hop y no deja pasar /checkout;x.css como asset", async () => {
        expect((await decide(req({ path: "/%73hop/entradas" }), CONFIG, deps())).type).toBe("redirect");
        expect((await decide(req({ path: "/shop/checkout;x.css" }), CONFIG, deps())).type).toBe("redirect");
    });
});

describe("destino guardado solo en navegaciones", () => {
    it("un fetch/XHR a una ruta protegida no pisa el destino", async () => {
        const d = await decide(req({ isNavigation: false }), CONFIG, deps());
        expect(d.type).toBe("redirect");
        expect(d.cookies).toEqual([]);
    });

    it("sin el dato (otros adaptadores) se guarda como antes", async () => {
        const d = await decide(req(), CONFIG, deps());
        expect(d.cookies.some((c) => c.name === targetCookieName("ev-42"))).toBe(true);
    });
});

describe("validateConfig — valores de ejemplo", () => {
    it("rechaza los placeholders de los instaladores", () => {
        expect(validateConfig({ client: "your-subdomain", privateKey: SECRET, adminHost: "a" }).ok).toBe(false);
        expect(validateConfig({ client: "orome", privateKey: "your-private-key", adminHost: "a" }).ok).toBe(false);
        expect(validateConfig({ client: "orome", privateKey: SECRET, adminHost: "a" }).ok).toBe(true);
    });
});
