// Lambda@Edge — viewer-request.
//
// Corre en CADA request del visitante (antes del cache). Decide si el visitante
// pasa, si vuelve de la cola con un token para canjear, o si va a la sala de
// espera. La renovación deslizante del pase la hace viewer-response, porque
// desde acá no se puede tocar una respuesta que todavía no existe.
//
// Presupuesto: 5s de timeout y 1 MB. El camino caliente (visitante con pase
// válido y config en memoria) no hace red: verifica el HMAC offline y sigue.
//
// Activación automática: las reglas con umbrales cuentan llegadas por contenedor
// y, una vez por segundo, el request que cruza el tick manda los totales al TC
// y toma el estado del evento (ver core/src/tc.js). Sin `tcToken` en la config
// no hay sensor y esas reglas encolan siempre.

import { buildLogger } from "@vqueue/connector-core/config";
import { sortRules } from "@vqueue/connector-core/acl";
import { getSettings } from "@vqueue/connector-core/settings";
import { decide } from "@vqueue/connector-core/decide";
import { createSensor } from "@vqueue/connector-core/tc";
import { logPhase } from "@vqueue/connector-core/timing";
import { markForRenewal, redirectResponse, stripInternalHeaders, toRequest } from "../cloudfront.js";
import { createConfigProvider } from "../runtime-config.js";
// Lo escribe `npm run build` con los datos del cliente, o queda con
// placeholders en el bundle sin configurar (que lee la config de Secrets Manager).
import { CONFIG as BAKED } from "../generated-config.js";

let logger = buildLogger(BAKED);
const getConfig = createConfigProvider(BAKED, { logger });

// El bundle sin configurar trae debug en false y la config real recién llega
// con el secreto, que puede pedirlo. Se rearma una vez por config.
let loggerConfig = BAKED;
function loggerFor(config) {
    if (config !== loggerConfig) {
        logger = buildLogger(config);
        loggerConfig = config;
    }
    return logger;
}

// Primera invocación del contenedor. En Lambda@Edge el cache de settings vive
// por contenedor y no hay forma de precalentarlo (ni provisioned concurrency ni
// invocación directa de las réplicas), así que saber si el request fue el
// primero es lo que separa "el conector tarda" de "el contenedor estaba frío".
let coldStart = true;

// Un viewer-request tiene 5 s de timeout y, si se pasa, CloudFront le devuelve un
// 503 al visitante: el fail-open de adentro no alcanza, porque un timeout no es
// una excepción. En un contenedor frío la primera llamada de red tarda ~2 s
// (medido a 128 MB, el máximo para este tipo de función) y encima suma la
// latencia hacia us-east-1. Pasado este presupuesto se suelta al visitante: lo
// que quedó en vuelo sigue y llena el cache para el próximo request.
const DEADLINE_MS = Number(BAKED.deadlineMs) || 4_000;

// El sensor vive con el contenedor (sus contadores y el estado cacheado). Se
// rearma solo si la config cambia (rotación del secreto).
let sensor = null;
let sensorConfig = null;
function sensorFor(config) {
    if (config !== sensorConfig) {
        sensor = createSensor(config, { logger });
        sensorConfig = config;
    }
    return sensor;
}

export async function handler(event) {
    const cfRequest = event.Records[0].cf.request;
    const startedAt = Date.now();
    const cold = coldStart;
    coldStart = false;

    // Siempre, incluso en fail-open: el header interno nunca viene del visitante.
    stripInternalHeaders(cfRequest);

    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
            logger.warn?.(`[vq] se agotó el presupuesto de ${DEADLINE_MS}ms, fail-open`);
            resolve(cfRequest);
        }, DEADLINE_MS);
    });

    try {
        return await Promise.race([handleRequest(cfRequest), deadline]);
    } finally {
        clearTimeout(timer);
        // `logger` se lee acá y no antes: para este punto ya es el de la
        // config resuelta, que es la que sabe si debug está encendido.
        logPhase(logger, "request", Date.now() - startedAt, cold ? "cold" : "warm");
    }
}

async function handleRequest(cfRequest) {
    try {
        // Sin config válida no se encola a nadie: fail-open.
        const config = await getConfig();
        if (!config) return cfRequest;
        loggerFor(config);

        const req = toRequest(cfRequest);

        const decision = await decide(req, config, {
            logger,
            getSettings: () => getSettings(config, { sortRules, logger }),
            verifyTimeoutMs: config.verifyTimeoutMs,
            sensor: sensorFor(config),
        });

        switch (decision.type) {
            case "redirect":
                return redirectResponse(decision.location, decision.cookies);

            case "allow":
                // La renovación viaja a viewer-response por header interno.
                return decision.renew ? markForRenewal(cfRequest, decision.renew) : cfRequest;

            case "bypass":
            default:
                return cfRequest;
        }
    } catch (err) {
        // Red de seguridad final: cualquier excepción deja pasar al visitante en
        // vez de devolverle un 503 en el sitio del cliente.
        console.error(`[vq] error inesperado, fail-open: ${err?.stack || err}`);
        return cfRequest;
    }
}
