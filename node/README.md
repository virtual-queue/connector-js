# @vqueue/connector-node

Queue protection **inside your own app**. For sites that are not behind our edge or
CloudFront, but can modify their backend.

It is the server-side equivalent of the JS adapter: a visitor can't bypass it by
disabling JavaScript.

## Usage

```js
import express from "express";
import { createQueueGuard } from "@vqueue/connector-node";

const app = express();

const guard = createQueueGuard({
  client: "orome",                            // your company subdomain
  privateKey: process.env.VQUEUE_PRIVATE_KEY, // never hardcode it
});

// Protects everything that matches an ACL with the redirect_to_queue action.
app.use(guard.express());

app.get("/shop/tickets", (req, res) => res.send("tickets"));
```

Fastify:

```js
fastify.addHook("onRequest", guard.fastify());
```

Any other framework:

```js
const decision = await guard.check({ host, path, query, cookies, method, isWebsocket });
if (guard.apply(decision, res)) return; // already responded (302 to the queue)
```

## Configuration

| Option | Default | What it is |
|---|---|---|
| `client` | `VQUEUE_CLIENT` | Your company subdomain in VirtualQueue |
| `privateKey` | `VQUEUE_PRIVATE_KEY` | Your company `private_key`; verifies the pass offline |
| `adminHost` | `clients.virtual-queue.com` | Where to download the ACLs from |
| `secureCookies` | `true` | Set to `false` only for development on `http://localhost` |
| `debug` | `false` | Verbose logs (per request) |

Unlike the Lambda@Edge connector, **environment variables are available here**, so
the `private_key` is never baked into a bundle.

## What it does, in order

1. **Cheap bypass** — assets, `/api/`, WebSockets, and methods other than GET/HEAD
   pass through without touching the network. A 302 on a POST would lose the
   checkout body.
2. **Return from the queue** — with `?vq_token=` it exchanges the token with
   `/api/v1/queue/verify`, issues the `vq_pass_<event_id>` cookie, and returns to
   the original destination. If the token isn't a queue token, the request
   continues normally: your site's own `?token=` parameters are never hijacked.
3. **ACLs** — downloads the rules (cached in process memory) and applies the
   matching one: by priority, first match wins.
4. **Pass** — verifies the HMAC signature **offline** with the `private_key`. It
   doesn't call VirtualQueue on every request.
5. **Sliding renewal** — while the visitor keeps browsing, the pass is extended.

Everything fails open: with no settings, no API, or an incomplete config, the
visitor gets through. An SDK that takes down your site is worse than one that
doesn't queue.

## Advantage over Lambda@Edge

Sliding renewal happens in a single pass. Lambda@Edge needs a second function
(`viewer-response`) because a `viewer-request` function can't touch a response that
doesn't exist yet.

## Limitations

The same as the AWS connector, since they share the core:

- **The pass isn't bound to the visitor.** The `QueuePass` payload carries no IP or
  User-Agent, so it can be passed between visitors of the same company. It is a
  bearer credential: whoever holds the cookie gets in.
- **It runs inside your app**, so it doesn't protect you from the traffic spike: the
  request still reaches your server. To stop the peak *before* it arrives you need
  the edge (Workers or Lambda@Edge).

## Tests

```bash
npm test
```
