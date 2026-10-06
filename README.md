# VirtualQueue — conectores JavaScript

Protección de sala de espera que **instalás en tu propia infraestructura**. Los
visitantes que llegan a una URL protegida se redirigen a la cola, y vuelven con un
pase firmado que se verifica offline con la `private_key` de tu compañía.

| Paquete | Para qué | Guía |
|---|---|---|
| [`aws-lambda-edge`](aws-lambda-edge) | CloudFront (Lambda@Edge). Frena el pico antes de que llegue a tu servidor. | [README](aws-lambda-edge/README.md) |
| [`node`](node) | Apps Node (Express, Fastify, `http`). Corre dentro de tu backend. | [README](node/README.md) |
| [`core`](core) | Lógica compartida. No se instala solo. | — |

Otros lenguajes: [PHP](https://github.com/virtual-queue/connector-php) ·
[.NET](https://github.com/virtual-queue/connector-dotnet) ·
[Cloudflare](https://github.com/virtual-queue/edge)

## Instalar el conector de CloudFront

Un click abre CloudFormation con todo cargado (región `us-east-1`):

**[Launch Stack](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=https%3A%2F%2Fvirtual-queue-connector-releases.s3.amazonaws.com%2Freleases%2Flatest%2Ftemplate.yaml)**

Te pide tu subdominio y tu `private_key`, que quedan en un secreto de tu cuenta de
AWS (nunca dentro de un zip). Después asociás las dos funciones a tu distribución de
CloudFront. Detalle completo en la [guía](aws-lambda-edge/README.md).

## Cómo decide

1. Assets, `/api/`, WebSockets y métodos distintos de GET/HEAD pasan sin tocar red.
2. Con `?vq_token=` canjea el token contra la API, emite la cookie `vq_pass_<evento>`
   y vuelve a donde el visitante quería ir.
3. Busca la regla que matchea la URL (por prioridad) y, si pide cola, verifica el
   pase de la cookie. Sin pase válido, redirige a la sala de espera.
4. Mientras el visitante navega, el pase se renueva.

**Todo falla abierto.** Sin settings, sin API o con config incompleta, el visitante
pasa: un conector que rompe tu sitio es peor que uno que no encola.

## Desarrollo

```bash
npm ci
npm test
```

El pase lo emite VQueue: `base64url(json) "." base64url(hmac_sha256(private_key,
base64url(json)))`. Los tests de `core` incluyen un vector firmado por la
implementación real, el mismo que usan los SDK de PHP y .NET, así que si un formato
cambia en cualquier lado, un test se cae.
