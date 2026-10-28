# VirtualQueue AWS Connector

Queue protection for customers who want to run it in **their own AWS account**,
instead of behind our edge. It does what the JS adapter does (rule-based
protection), but on the server side: a visitor can't bypass it by disabling
JavaScript. Rules with a traffic threshold also **activate on their own** when the
traffic arrives (see *Automatic activation*).

It is two **Lambda@Edge** functions attached to a CloudFront distribution.

## What it does

1. **Cheap bypass** — assets, `/api/`, WebSockets, and methods other than GET/HEAD
   pass through without touching the network or verifying anything. A 302 on a POST
   would lose the checkout body, and Lambda@Edge is billed per invocation.
2. **Return from the queue** — with `?vq_token=` (or the legacy `?token=`) it
   exchanges the token with `/api/v1/queue/verify`, issues the `vq_pass_<event_id>`
   cookie, and redirects to the original destination. If the token is **not** a
   queue token, the request continues normally: your site's own `?token=` (password
   reset, magic link) is never hijacked.
3. **ACLs** — downloads your rules and applies the matching one: by priority, first
   match wins.
4. **Pass** — verifies the signature **offline** with your company's `private_key`.
   It doesn't call VirtualQueue on every request.
5. **Automatic activation** — a rule with a threshold or a max load only queues
   while VirtualQueue's traffic counter says the event is active. A rule without
   thresholds queues every visitor without a pass, as before.
6. **Sliding renewal** — while the visitor keeps browsing, the pass is extended.

Everything fails open: with no settings, an unresponsive verify endpoint, or a bad
config, the visitor gets through. A connector that breaks your site is worse than
one that doesn't queue.

## Automatic activation

Each rule is **manual** or **automatic**, and you switch between the two from the
VirtualQueue panel, without touching your AWS:

| Rule | Behaviour |
|---|---|
| No threshold and no max load | Manual: every visitor without a pass goes to the waiting room. |
| A threshold (arrivals/s) or a max load (concurrent buyers) | Automatic: visitors pass straight through until the traffic crosses the threshold; then the queue turns on, and it turns off again when the peak is over. |

Automatic rules need the **Traffic counter token** of your company (company
settings in the panel), given to the stack as `TcToken`. With it, every function
container counts the visitors that reach an automatic rule without a pass and, once
per second, sends the **totals** (arrivals and distinct visitors, deduplicated by
IP + User-Agent inside the container) to `tc.virtual-queue.com`. The reply carries
the event state, which the container applies for the next second. The traffic
counter never receives paths, IPs, cookies or any per-visitor data: one line of
numbers per container per second, whatever your traffic is.

Failure policy, in the same spirit as the rest of the connector:

- Counter unreachable or slow (800 ms timeout): the last known state is kept for
  60 s, then visitors pass (fail-open). The counter can never take your site down.
- Automatic rule but no `TcToken`: the rule behaves as manual (queues everyone) and
  the logs say so once every 10 minutes.
- `TcToken` rejected by the counter (typo, rotated): same thing, queue everyone and
  log an error. A wrong token never disables protection silently.

Cost: the request that crosses the one-second tick pays one extra network call
(100-200 ms from us-east-1); the other requests of that second don't touch the
network. Only visitors **without a pass** are counted, so visitors already admitted
never pay it.

## Installation

There are two ways. Both end the same way: two Lambda@Edge functions attached to a
CloudFront behavior.

### A) With CloudFormation (recommended)

One click opens the AWS console with everything pre-filled, in `us-east-1`:

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=https%3A%2F%2Fvirtual-queue-connector-releases.s3.amazonaws.com%2Freleases%2Flatest%2Ftemplate.yaml)

It asks for two values, plus an optional one:

- **Client**: your company subdomain in VirtualQueue (the same one the JS adapter
  uses).
- **PrivateKey**: your company `private_key`. Contact VirtualQueue support if you
  don't have it.
- **TcToken** (optional): your *Traffic counter token*, from the company settings in
  the panel. Only needed if some rule has a threshold or a max load (see *Automatic
  activation*). You can add it later by editing the secret.

The stack creates the two functions, their role, and a **Secrets Manager** secret
(`vqueue/connector`) that holds your key and token. They **never travel inside a
zip**: the release zips are identical for every customer.

When it finishes, *Outputs* lists the ARNs of the two function versions. One step
is left that CloudFormation can't do for you: in CloudFront, edit the behavior you
want to protect and add the two associations (**Viewer request** and **Viewer
response**).

To rotate the key, edit the `vqueue/connector` secret; the functions pick it up
within 5 minutes.

### B) Downloading the zips

Download `viewer-request.zip` and `viewer-response.zip` from the latest release
(they ship unconfigured), or build them yourself with your own values:

```bash
npm install
npm run build -- --client <subdomain> --private-key <private_key>
```

With that build the config is embedded in the bundle, and you get
`dist/viewer-request.zip` and `dist/viewer-response.zip`. The build packages with
the system `zip` (available on macOS and Linux; on Windows use WSL or Git Bash).

Then, in AWS:

1. Create two Lambda functions in **us-east-1** (Lambda@Edge can only be deployed
   from there), Node.js 22 runtime, and upload one zip to each.
2. Publish a version of each function (Lambda@Edge doesn't accept `$LATEST`).
3. In your CloudFront distribution, on the behavior to protect, attach:
   - **Viewer request** → the viewer-request function
   - **Viewer response** → the viewer-response function
4. **Do not** add the `vq_pass_*` / `vq_target_*` cookies to the behavior's cache
   key. Viewer functions always see them, regardless of the cache policy; adding
   them would make every visitor (each pass is unique) fragment the CloudFront
   cache so nothing gets served from cache. Your origin doesn't need them either.

### About the key

Lambda@Edge **doesn't support environment variables**. So the config comes from one
of two places: the Secrets Manager secret (path A) or embedded in the bundle (path
B). In path B the build injects it in memory: `src/generated-config.js` is committed
with placeholders only, and the `private_key` never touches the source tree. Still,
treat those zips as sensitive material.

If there is no valid config from either place (missing secret, no permission, empty
key), the connector starts in fail-open mode: it lets everything through and says so
in the logs, instead of queueing with made-up data.

### Measuring where the time goes

With `debug` on, the connector logs one line per phase to CloudWatch, so you can
tell a cold container apart from a slow network call:

```
[timing] config 412ms secret      ← reading the Secrets Manager secret (path A only)
[timing] settings 1483ms ok       ← GET /api/v1/adapter/:client/settings
[timing] verify 607ms ok          ← POST /queue/verify, only when returning from the queue
[timing] sensor 118ms active      ← traffic counter tick, only with a tcToken
[timing] decide 1502ms redirect   ← the whole decision, including the waits above
[timing] request 1961ms cold      ← the whole viewer-request, and whether it was
                                    the container's first invocation
```

A phase that does not appear did not run: no `settings` line means the container
already had them cached. `cold` vs `warm` matters because the settings cache lives
**per container**, and Lambda@Edge cannot be pre-warmed — with low traffic, many
visitors land on a cold container and pay the full chain.

Turning it on, depending on how you installed:

- **Path A (Secrets Manager)**: add `"debug": true` to the `vqueue/connector`
  secret. The functions pick it up within 5 minutes.
- **Path B (your own build)**: rebuild with `--debug`.

These lines are **per request**: turn debug off when you are done measuring.

### Deleting the stack

A Lambda@Edge function can't be deleted while CloudFront has it attached, and its
replicas take a while to be released. First remove the associations from the
behavior, wait for the distribution to finish deploying, and only then delete the
stack. The secret is scheduled for deletion, and its name can't be reused during that
period.

## Why two functions

`viewer-request` can return its own response (the 302 to the queue), but it **can't
add a cookie to a response that comes from the origin**. Sliding renewal needs
exactly that, which is why `viewer-response` exists.

The bridge between them is an internal header (`x-vq-renew`) that viewer-request
adds to the request. Known trade-off: that header travels to the origin. If a
visitor sends it themselves, viewer-request discards it before deciding anything:
nobody can ask viewer-response to set an arbitrary cookie.

## Performance and Lambda@Edge limits

A viewer-request function has a **5 s timeout and 128 MB**, and if it exceeds the
timeout CloudFront returns a 503 to the visitor. Measured on a real function:

- **Cold container:** ~2.5 s (the first network call of a new container takes ~2 s;
  after that, 100–400 ms per call).
- **Warm container:** 10–20 ms.

That's why the connector has a total budget of 4 s: if something hangs (the secret,
the settings), it lets the visitor through instead of letting the timeout expire.
The settings fetch itself waits up to 3 s (`settingsTimeoutMs`): a shorter value
makes the first visitor of each container pass unprotected, because the cold fetch
gets aborted and the failure is cached for 5 s. Once a container has a copy, an
expired one is served while the refresh runs. A container is frozen as soon as it
answers, so the refresh only finishes if the next request arrives within
`settingsTimeoutMs`; with sparser traffic that next request waits for a fresh copy
instead (~300–700 ms, once every `settingsTtlMs`).

The first request of a container pays this once per CloudFront edge location and
again after the container is recycled. Nothing in the connector can shorten it: the
cost is the first network call of a fresh Node process at 128 MB, not module
initialization (~120 ms) nor the Admin API (~300 ms warm).
And that's why it reads the secret with a hand-signed request instead of the AWS SDK,
whose import alone takes ~2.5 s at 128 MB.

## Contracts with VirtualQueue

| What | Where | Authentication |
|---|---|---|
| ACLs + queue URL | `GET https://<admin>/api/v1/adapter/<client>/settings` | **None** (public, cacheable) |
| Token exchange | `GET <queue_url>/api/v1/queue/verify?token=` | None |
| Pass | `vq_pass_<event_id>` cookie | HMAC-SHA256 with `private_key`, offline |
| Traffic totals + event state | `POST https://tc.virtual-queue.com/v1/ingest`, one `v1` line per container per second | Company *Traffic counter token*, inside the line |

The connector uses the **public** settings endpoint, not `/api/v1/edge/config/`:
the latter is internal to the platform and requires a token that is not given to
customers.

The pass format is `base64url(json) "." base64url(hmac_sha256(private_key,
base64url(json)))`, unpadded, with payload `{t, e, iat, exp}`.
`core/test/pass.test.js` includes a vector signed by the real VirtualQueue
implementation: if either side changes the format, that test fails.

## Tests

```bash
npm test
```

## Known limitations

- **The pass isn't bound to the visitor.** The `QueuePass` payload carries no IP or
  User-Agent, so it can be passed between visitors of the same company. It is a
  bearer credential: whoever holds the cookie gets in.
- **The queue token is single-use**, with a 60 s grace window on the API side: if the
  exchange fails right after the token is marked (timeout, redirect loop in the CDN),
  an immediate retry gets the same pass again. After the window, the visitor has to
  go through the queue again.
- **Only a UUID is a queue token.** `?token=` and `?vq_token=` are claimed only when
  they look like a UUID (it's the line id), like the JS adapter. Your site's own
  `?token=` never costs a round trip to VirtualQueue.
- **The traffic counter sees totals, not visitors.** Distinct visitors are counted
  per container, so the same visitor served by two containers counts twice. It is a
  bounded overestimate, the same the managed edge has.
- **Lambda@Edge has a ceiling.** The default quota is 10,000 requests per second per
  region for viewer functions; CloudFront answers 503 above it. For spikes beyond
  that, the queue has to run in front of CloudFront.
