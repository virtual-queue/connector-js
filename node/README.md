# @vqueue/connector-node

Protección de cola **dentro de la app del cliente**. Para quien no está detrás de
nuestro edge ni de CloudFront, pero sí puede tocar su backend.

Es el equivalente server-side del JS adapter: el visitante no puede saltearla
desactivando JavaScript.

## Uso

```js
import express from "express";
import { createQueueGuard } from "@vqueue/connector-node";

const app = express();

const guard = createQueueGuard({
  client: "orome",                            // subdominio de la compañía
  privateKey: process.env.VQUEUE_PRIVATE_KEY, // nunca hardcodeada
});

// Protege todo lo que matchee una ACL con acción redirect_to_queue.
app.use(guard.express());

app.get("/shop/entradas", (req, res) => res.send("entradas"));
```

Fastify:

```js
fastify.addHook("onRequest", guard.fastify());
```

Cualquier otro framework:

```js
const decision = await guard.check({ host, path, query, cookies, method, isWebsocket });
if (guard.apply(decision, res)) return; // ya respondió (302 a la cola)
```

## Configuración

| Opción | Default | Qué es |
|---|---|---|
| `client` | `VQUEUE_CLIENT` | Subdominio de la compañía en VQueue |
| `privateKey` | `VQUEUE_PRIVATE_KEY` | `private_key` de la compañía; verifica el pase offline |
| `adminHost` | `clients.virtual-queue.com` | De dónde bajar las ACLs |
| `secureCookies` | `true` | Poner en `false` solo para desarrollo en `http://localhost` |
| `debug` | `false` | Logs verbosos (son por request) |

A diferencia del conector de Lambda@Edge, acá **hay variables de entorno**: la
`private_key` no se hornea en ningún bundle.

## Qué hace, en orden

1. **Bypass barato** — assets, `/api/`, WebSockets y métodos que no son GET/HEAD
   pasan sin tocar red. Un 302 sobre un POST perdería el body del checkout.
2. **Vuelta de la cola** — con `?vq_token=` canjea contra `/api/v1/queue/verify`,
   emite la cookie `vq_pass_<event_id>` y vuelve al destino original. Si el token
   no es de la cola, el request sigue el flujo normal: un `?token=` propio del
   sitio nunca se secuestra.
3. **ACLs** — baja las reglas (cacheadas en memoria del proceso) y aplica la que
   matchee, por prioridad, primera gana.
4. **Pase** — verifica la firma HMAC **offline** con la `private_key`. No llama a
   VQueue en cada request.
5. **Renovación deslizante** — mientras el visitante navegue, el pase se extiende.

Todo falla abierto: sin settings, sin API o con config incompleta, el visitante
pasa. Un SDK que tumba el sitio del cliente es peor que uno que no encola.

## Ventaja sobre Lambda@Edge

La renovación deslizante se resuelve en una sola pasada. Lambda@Edge necesita una
segunda función (`viewer-response`) porque desde `viewer-request` no se puede
tocar una respuesta que todavía no existe.

## Limitaciones

Las mismas del conector de AWS, porque comparten el core:

- **El pase no está atado al visitante** — el payload de `QueuePass` no lleva IP
  ni User-Agent, así que es transferible dentro de la misma compañía. Es un
  bearer credential: quien tiene la cookie, pasa.
- **Corre dentro de tu app**, así que no te protege de la avalancha: el request
  igual llega a tu server. Para frenar el pico *antes* hace falta el edge
  (Workers o Lambda@Edge).

## Tests

```bash
npm test
```
