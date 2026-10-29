# VirtualQueue Cloudflare Connector

Queue protection for customers who want to run it in **their own Cloudflare
account**. It does what the JS adapter does (rule-based protection), but on the
server side: a visitor can't bypass it by disabling JavaScript. With the traffic
counter token, rules with a threshold turn the queue on and off by themselves (see
*Automatic activation*).

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
5. **Automatic activation** — a rule with a threshold or a max load only queues
   while VirtualQueue's traffic counter says the event is active. A rule without
   thresholds queues every visitor without a pass, as before.
6. **Sliding renewal** — while the visitor keeps browsing, the pass is extended.
   A Worker sees the origin's response, so this needs no second function.

Everything fails open: with no config (or the example values left in place), an
unreachable rules endpoint, an unreachable or failing verify endpoint, or any
unexpected error, the visitor gets through. If the passes issued by VirtualQueue
don't validate with your `PRIVATE_KEY` (wrong or rotated key), the connector stops
queueing for 5 minutes and logs an error, instead of looping visitors through the
queue. A connector that breaks your site is worse than one that doesn't queue.

**What rules can't cover.** Only GET/HEAD navigations are checked. Requests with
other methods, paths under `/api/`, static assets and WebSockets always pass. If
your purchase is confirmed with a POST or under `/api/`, check the pass (or the
token) in that endpoint too.

## Automatic activation

Each rule is **manual** or **automatic**, and you switch between the two from the
VirtualQueue panel, without redeploying the Worker:

| Rule | Behaviour |
|---|---|
| No threshold and no max load | Manual: every visitor without a pass goes to the waiting room. |
| A threshold (arrivals/s) or a max load (concurrent buyers) | Automatic: visitors pass straight through until the traffic crosses the threshold; then the queue turns on, and it turns off again when the peak is over. |

Automatic rules need the **Traffic counter token** of your company (company
settings in the panel), stored as the `TC_TOKEN` secret. With it, every Worker
isolate counts the visitors that reach an automatic rule without a pass and, once
per second, sends the **totals** (arrivals and distinct visitors, deduplicated by
IP + User-Agent inside the isolate) to `tc.virtual-queue.com`. The reply carries
the event state, which the isolate applies for the next second. The traffic
counter never receives paths, IPs, cookies or any per-visitor data: one line of
numbers per isolate per second, whatever your traffic is.

Failure policy, in the same spirit as the rest of the connector:

- Counter unreachable or slow (800 ms timeout): the last known state is kept for
  60 s, then visitors pass (fail-open). The counter can never take your site down.
- Automatic rule but no `TC_TOKEN`: the rule behaves as manual (queues everyone) and
  the logs say so once every 10 minutes.
- `TC_TOKEN` rejected by the counter (typo, rotated): same thing, queue everyone and
  log an error. A wrong token never disables protection silently.

Cost: the request that crosses the one-second tick waits for one extra network
call; the other requests of that second don't touch the network. Only visitors
**without a pass** are counted, so visitors already admitted never pay it.

## Installation

You need a Cloudflare account and a domain **proxied through Cloudflare** (orange
cloud).

### Before you install

- **Workers plan.** Every request on the route is a Worker invocation, assets
  included. The Free plan is capped at 100,000 requests per day; above that the
  route either errors or skips the Worker, depending on its failure mode. For a
  real sale use a paid Workers plan, and set the route's failure mode to
  **Fail open** so a limit or outage never takes your site down.
- **The route must cover your return URL.** VirtualQueue sends visitors back to
  your site URL + purchase URL with `?token=`. That URL has to be on the same host
  as the protected pages, inside the route, and not under `/api/` or with an asset
  extension. Otherwise the token is never exchanged and the visitor loops.

### A) Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/virtual-queue/connector-js/tree/main/cloudflare-worker)

It asks for two secrets (from `.dev.vars.example`):

- **CLIENT**: your company subdomain in VirtualQueue (the same one the JS adapter
  uses).
- **PRIVATE_KEY**: your company `private_key`. Contact VirtualQueue support if you
  don't have it.

Both are stored as Worker **secrets** in your account, so later deploys don't reset
them. If you leave the example values, the Worker lets everything through and logs
why.

If some rule has a threshold or a max load, add the `TC_TOKEN` secret afterwards
(Worker → **Settings** → **Variables and Secrets** → **Add**, type *Secret*), or
with `npx wrangler secret put TC_TOKEN`.

### B) From the command line

```bash
git clone https://github.com/virtual-queue/connector-js.git
cd connector-js/cloudflare-worker
npm install
npx wrangler secret put CLIENT
npx wrangler secret put PRIVATE_KEY
npx wrangler secret put TC_TOKEN   # optional, only for automatic rules
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
| `CLIENT` | secret | Your company subdomain in VirtualQueue |
| `PRIVATE_KEY` | secret | Your company `private_key`; verifies the pass offline |
| `TC_TOKEN` | secret, optional | Your *Traffic counter token*; enables automatic rules |
| `ADMIN_HOST` | variable, optional | Defaults to `clients.virtual-queue.com` |
| `TC_URL` | variable, optional | Defaults to `https://tc.virtual-queue.com` |
| `DEBUG` | variable, optional | `"true"` for verbose logs (per request) |

**Rotating the key.** Ask VirtualQueue for the new key, then run
`npx wrangler secret put PRIVATE_KEY` right away. Passes issued with the old key
stop validating, so visitors who already have one go back to the queue once. If
the key changes on the VirtualQueue side first, the connector detects the mismatch
and lets traffic through (and logs it) until you update the secret.

Rule changes reach visitors in about a minute: the rules endpoint is cached for
up to 60 s, plus 30 s in each Worker instance.

### Measuring where the time goes

With `DEBUG="true"`, the connector logs one line per phase, so a slow network call is easy
to tell apart from the rest:

```
[timing] settings 1483ms ok      ← GET /api/v1/adapter/:client/settings
[timing] verify 607ms ok         ← POST /queue/verify, only when returning from the queue
[timing] sensor 118ms active     ← traffic counter tick, only with a tcToken
[timing] decide 1502ms redirect  ← the whole decision, including the waits above
```

`[timing] request 1961ms cold` closes the connector's part, before going to the
origin, and says whether this was the isolate's first request. It matters because
the settings cache lives **per isolate**.

A phase that does not appear did not run: no `settings` line means they were
already cached. These lines are **per request**: turn debug off when you are done
measuring.

## Contracts with VirtualQueue

| What | Where | Authentication |
|---|---|---|
| Rules + queue URL | `GET https://<admin>/api/v1/adapter/<client>/settings` | **None** (public, cacheable) |
| Token exchange | `GET <queue_url>/api/v1/queue/verify?token=` | None |
| Pass | `vq_pass_<event_id>` cookie | HMAC-SHA256 with `private_key`, offline |
| Traffic totals + event state | `POST https://tc.virtual-queue.com/v1/ingest`, one `v1` line per isolate per second | Company *Traffic counter token*, inside the line |

The connector uses the **public** settings endpoint. It never needs a platform
token: the traffic counter token is your company's own, from the panel.

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
