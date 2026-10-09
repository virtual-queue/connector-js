# VirtualQueue Cloudflare Connector

Queue protection for customers who want to run it in **their own Cloudflare
account**. It does what the JS adapter does (rule-based protection, no automatic
load sensors), but on the server side: a visitor can't bypass it by disabling
JavaScript.

It is a single **Cloudflare Worker** attached to a route of your zone.

## What it does

1. **Cheap bypass** — assets, `/api/`, WebSockets, and methods other than GET/HEAD
   pass through without touching the network. A 302 on a POST would lose the
   checkout body.
2. **Return from the queue** — with `?vq_token=` (or the legacy `?token=`) it
   exchanges the token with `/api/v1/queue/verify`, issues the `vq_pass_<event_id>`
   cookie, and redirects to the original destination. If the token is **not** a
   queue token, the request continues normally: your site's own `?token=` (password
   reset, magic link) is never hijacked.
3. **Rules** — downloads your access rules and applies the matching one. **Lowest
   priority number wins**, like a firewall: rule 0 is checked first and overrides
   rule 1.
4. **Pass** — verifies the signature **offline** with your company's `private_key`.
   It doesn't call VirtualQueue on every request.
5. **Sliding renewal** — while the visitor keeps browsing, the pass is extended.
   A Worker sees the origin's response, so this needs no second function.

Everything fails open: with no config, an unreachable API, or any unexpected error,
the visitor gets through. A connector that breaks your site is worse than one that
doesn't queue.

## Installation

You need a Cloudflare account and a domain **proxied through Cloudflare** (orange
cloud).

### A) Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/virtual-queue/connector-js/tree/main/cloudflare-worker)

It asks for two values:

- **CLIENT**: your company subdomain in VirtualQueue (the same one the JS adapter
  uses).
- **PRIVATE_KEY**: your company `private_key`. Contact VirtualQueue support if you
  don't have it. It is stored as a Worker **secret** in your account.

### B) From the command line

```bash
git clone https://github.com/virtual-queue/connector-js.git
cd connector-js/cloudflare-worker
npm install
# edit wrangler.jsonc: set CLIENT to your subdomain
npx wrangler secret put PRIVATE_KEY
npx wrangler deploy
```

### Attach it to your domain

Deploying does not put the Worker in front of your site. One step is left:

1. Cloudflare dashboard → your domain → **Workers Routes** → **Add route**.
2. Route: the part of your site to protect, for example `shop.example.com/*`.
3. Worker: `vqueue-connector`.

Then create the queue and the access rules in the VirtualQueue panel. Without any
active rule, everything passes straight through.

## Configuration

| Name | Type | What it is |
|---|---|---|
| `CLIENT` | variable | Your company subdomain in VirtualQueue |
| `PRIVATE_KEY` | secret | Your company `private_key`; verifies the pass offline |
| `ADMIN_HOST` | variable, optional | Defaults to `clients.virtual-queue.com` |
| `DEBUG` | variable, optional | `"true"` for verbose logs (per request) |

To rotate the key: `npx wrangler secret put PRIVATE_KEY` again.

## Contracts with VirtualQueue

| What | Where | Authentication |
|---|---|---|
| Rules + queue URL | `GET https://<admin>/api/v1/adapter/<client>/settings` | **None** (public, cacheable) |
| Token exchange | `GET <queue_url>/api/v1/queue/verify?token=` | None |
| Pass | `vq_pass_<event_id>` cookie | HMAC-SHA256 with `private_key`, offline |

The connector uses the **public** settings endpoint. It never needs a platform
token: nothing in this repository asks you for one.

## Keeping `vendor/` in sync

The Deploy button clones only this folder, so it can't resolve the shared `core`
workspace. `vendor/` is a copy of `../core/src`. After changing `core`, run:

```bash
npm run sync
```

`test/vendor-sync.test.js` fails if the copy drifts.

## Tests

```bash
npm ci
npm test
```
