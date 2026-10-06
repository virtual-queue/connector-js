# VirtualQueue AWS Connector

Queue protection for customers who want to run it in **their own AWS account**,
instead of behind our edge. It does what the JS adapter does (rule-based
protection, no automatic load sensors), but on the server side: a visitor can't
bypass it by disabling JavaScript.

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
5. **Sliding renewal** — while the visitor keeps browsing, the pass is extended.

Everything fails open: with no settings, an unresponsive verify endpoint, or a bad
config, the visitor gets through. A connector that breaks your site is worse than
one that doesn't queue.

## Installation

There are two ways. Both end the same way: two Lambda@Edge functions attached to a
CloudFront behavior.

### A) With CloudFormation (recommended)

One click opens the AWS console with everything pre-filled, in `us-east-1`:

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=https%3A%2F%2Fvirtual-queue-connector-releases.s3.amazonaws.com%2Freleases%2Flatest%2Ftemplate.yaml)

It asks for two values:

- **Client**: your company subdomain in VirtualQueue (the same one the JS adapter
  uses).
- **PrivateKey**: your company `private_key`. Contact VirtualQueue support if you
  don't have it.

The stack creates the two functions, their role, and a **Secrets Manager** secret
(`vqueue/connector`) that holds your key. The key **never travels inside a zip**:
the release zips are identical for every customer.

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
And that's why it reads the secret with a hand-signed request instead of the AWS SDK,
whose import alone takes ~2.5 s at 128 MB.

## Contracts with VirtualQueue

| What | Where | Authentication |
|---|---|---|
| ACLs + queue URL | `GET https://<admin>/api/v1/adapter/<client>/settings` | **None** (public, cacheable) |
| Token exchange | `GET <queue_url>/api/v1/queue/verify?token=` | None |
| Pass | `vq_pass_<event_id>` cookie | HMAC-SHA256 with `private_key`, offline |

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
- **No automatic protection.** This connector has no load sensors; activation is
  per rule (`enabled`).
