import { describe, it, expect } from "vitest";
import {
    parseCookies,
    toRequest,
    redirectResponse,
    cookieHeader,
    markForRenewal,
    readRenewal,
    stripInternalHeaders,
    RENEW_HEADER,
} from "../src/cloudfront.js";

// En Lambda@Edge los headers son claves en minúscula y cada una es un ARRAY de
// {key, value}. Es la fuente clásica de bugs al portar código de otro edge.
function cfRequest({ uri = "/", querystring = "", method = "GET", headers = {} } = {}) {
    return { uri, querystring, method, headers };
}

function header(name, ...values) {
    return { [name]: values.map((value) => ({ key: name, value })) };
}

describe("cloudfront — cookies", () => {
    it("parsea varias cookies de una entrada", () => {
        const jar = parseCookies(header("cookie", "a=1; b=2; vq_pass_ev-42=xyz"));
        expect(jar).toEqual({ a: "1", b: "2", "vq_pass_ev-42": "xyz" });
    });

    it("junta cookies repartidas en VARIAS entradas", () => {
        // CloudFront puede entregar el header Cookie partido; si solo se lee la
        // primera entrada se pierden cookies y el visitante vuelve a la cola.
        const jar = parseCookies(header("cookie", "a=1", "vq_pass_ev-42=xyz"));
        expect(jar).toEqual({ a: "1", "vq_pass_ev-42": "xyz" });
    });

    it("tolera un valor con '=' adentro (base64url del pase)", () => {
        const jar = parseCookies(header("cookie", "vq_pass_ev-42=abc.def=="));
        expect(jar["vq_pass_ev-42"]).toBe("abc.def==");
    });

    it("sin header Cookie devuelve vacío", () => {
        expect(parseCookies({})).toEqual({});
    });

    it("decodifica el valor percent-encoded que escribió cookieHeader", () => {
        const written = cookieHeader({ name: "vq_target_ev-42", value: "/shop/a;b?x=1", maxAge: 60 });
        const value = written.split(";")[0].split("=").slice(1).join("=");

        expect(parseCookies(header("cookie", `vq_target_ev-42=${value}`))["vq_target_ev-42"]).toBe("/shop/a;b?x=1");
    });

    it("una cookie ajena con % inválido se devuelve cruda, sin lanzar", () => {
        expect(parseCookies(header("cookie", "ajena=100%"))).toEqual({ ajena: "100%" });
    });
});

describe("cloudfront — request normalizado", () => {
    it("extrae host, path, query y método", () => {
        const req = toRequest(cfRequest({
            uri: "/shop/entradas",
            querystring: "token=abc&sku=7",
            headers: header("host", "shop.test"),
        }));

        expect(req.host).toBe("shop.test");
        expect(req.path).toBe("/shop/entradas");
        expect(req.query.get("token")).toBe("abc");
        expect(req.query.get("sku")).toBe("7");
        expect(req.method).toBe("GET");
    });

    it("detecta el upgrade de WebSocket sin importar mayúsculas", () => {
        const req = toRequest(cfRequest({ headers: header("upgrade", "WebSocket") }));
        expect(req.isWebsocket).toBe(true);
    });
});

describe("cloudfront — respuestas", () => {
    it("arma el 302 con Location y sin cache", () => {
        const res = redirectResponse("https://orome.virtual-queue.com/queue/ev-42");

        expect(res.status).toBe("302");
        expect(res.headers.location[0].value).toBe("https://orome.virtual-queue.com/queue/ev-42");
        expect(res.headers["cache-control"][0].value).toBe("no-store");
    });

    it("emite una entrada Set-Cookie por cookie", () => {
        const res = redirectResponse("/destino", [
            { name: "vq_pass_ev-42", value: "xyz", maxAge: 600 },
            { name: "vq_target_ev-42", value: "", maxAge: 0 },
        ]);

        expect(res.headers["set-cookie"]).toHaveLength(2);
        expect(res.headers["set-cookie"][0].value).toContain("vq_pass_ev-42=xyz");
    });

    it("percent-encodea el valor: un ';' en el destino no corta la cookie", () => {
        const value = cookieHeader({ name: "vq_target_ev-42", value: "/shop/a;b", maxAge: 60 });

        expect(value.startsWith("vq_target_ev-42=%2Fshop%2Fa%3Bb; ")).toBe(true);
    });

    it("no altera el pase (base64url) al encodearlo", () => {
        const pass = "abc-_.xyz";
        expect(cookieHeader({ name: "p", value: pass, maxAge: 1 })).toContain(`p=${pass};`);
    });

    it("el pase es HttpOnly y Secure", () => {
        const value = cookieHeader({ name: "vq_pass_ev-42", value: "xyz", maxAge: 600 });

        expect(value).toContain("HttpOnly");
        expect(value).toContain("Secure");
        expect(value).toContain("SameSite=Lax");
        expect(value).toContain("Max-Age=600");
    });
});

describe("cloudfront — puente entre las dos lambdas", () => {
    it("viewer-request marca y viewer-response lee la renovación", () => {
        const renew = { name: "vq_pass_ev-42", value: "xyz", maxAge: 600 };
        const request = cfRequest({ headers: header("host", "shop.test") });

        markForRenewal(request, renew);
        expect(request.headers[RENEW_HEADER]).toBeDefined();

        expect(readRenewal(request)).toEqual(renew);
    });

    it("sin marca no hay renovación", () => {
        expect(readRenewal(cfRequest())).toBeNull();
    });

    it("una marca corrupta no rompe (devuelve null)", () => {
        const request = cfRequest({ headers: header(RENEW_HEADER, "no-es-base64-json") });
        expect(readRenewal(request)).toBeNull();
    });

    it("descarta la marca si la trae el visitante", () => {
        // Si no, cualquiera podría pedirle a viewer-response la cookie que quiera.
        const request = cfRequest({ headers: { ...header("host", "shop.test"), ...header(RENEW_HEADER, "x") } });

        stripInternalHeaders(request);

        expect(request.headers[RENEW_HEADER]).toBeUndefined();
        expect(request.headers.host).toBeDefined();
        expect(readRenewal(request)).toBeNull();
    });
});
