# VirtualQueue — JavaScript connectors

Waiting-room protection that you **install in your own infrastructure**. Visitors
who hit a protected URL are redirected to the queue, and come back with a signed
pass that is verified offline with your company's `private_key`.

| Package | Use it for | Guide |
|---|---|---|
| [`aws-lambda-edge`](aws-lambda-edge) | CloudFront (Lambda@Edge). Stops the traffic spike before it reaches your servers. | [README](aws-lambda-edge/README.md) |
| [`cloudflare-worker`](cloudflare-worker) | Cloudflare Workers. Runs in your own Cloudflare account, in front of your site. | [README](cloudflare-worker/README.md) |
| [`node`](node) | Node apps (Express, Fastify, plain `http`). Runs inside your backend. | [README](node/README.md) |
| [`core`](core) | Shared logic. Not installed on its own. | — |

Other platforms: [PHP](https://github.com/virtual-queue/connector-php) ·
[.NET](https://github.com/virtual-queue/connector-dotnet)

## Install the CloudFront connector

One click opens CloudFormation with everything pre-filled (region `us-east-1`):

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=https%3A%2F%2Fvirtual-queue-connector-releases.s3.amazonaws.com%2Freleases%2Flatest%2Ftemplate.yaml)

It asks for your subdomain and your `private_key`, which are stored in a secret in
your own AWS account (never inside a zip). Then you attach the two functions to
your CloudFront distribution. See the [full guide](aws-lambda-edge/README.md).

## How it decides

1. Assets, `/api/`, WebSockets, and any method other than GET/HEAD pass through
   without touching the network.
2. With `?vq_token=` it exchanges the token with the API, issues the
   `vq_pass_<event>` cookie, and sends the visitor back to where they were going.
3. It finds the rule that matches the URL (by priority) and, if the rule requires
   the queue, verifies the pass cookie. Without a valid pass, it redirects to the
   waiting room.
4. While the visitor keeps browsing, the pass is renewed.

**Everything fails open.** With no settings, no API, or an incomplete config, the
visitor gets through: a connector that breaks your site is worse than one that
doesn't queue.

## Development

```bash
npm ci
npm test
```

The pass is issued by VirtualQueue: `base64url(json) "." base64url(hmac_sha256(private_key,
base64url(json)))`. The `core` tests include a vector signed by the real
implementation, the same one used by the PHP and .NET SDKs, so if the format
changes anywhere, a test fails.
