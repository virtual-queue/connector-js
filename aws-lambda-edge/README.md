# VQueue AWS Connector

Protección de cola para clientes que quieren correrla en **su propio AWS**, en vez
de detrás de nuestro edge. Hace lo mismo que el JS adapter (protección por reglas,
sin sensores automáticos), pero del lado del servidor: el visitante no puede
saltearla desactivando JavaScript.

Son dos funciones **Lambda@Edge** asociadas a una distribución de CloudFront.

## Qué hace

1. **Bypass barato** — assets, `/api/`, WebSockets y métodos que no son GET/HEAD
   pasan sin tocar red ni verificar nada. Un 302 sobre un POST perdería el body
   del checkout, y en Lambda@Edge se paga por invocación.
2. **Vuelta de la cola** — con `?vq_token=` (o el `?token=` legacy) canjea el
   token contra `/api/v1/queue/verify`, emite la cookie `vq_pass_<event_id>` y
   redirige al destino original. Si el token **no** es de la cola, el request
   sigue el flujo normal: un `?token=` propio del sitio (reset de password, magic
   link) nunca se secuestra.
3. **ACLs** — descarga las reglas del cliente y aplica la que matchee, por
   prioridad, primera gana.
4. **Pase** — verifica la firma **offline** con la `private_key` de la compañía.
   No llama a VQueue en cada request.
5. **Renovación deslizante** — mientras el visitante navegue, el pase se extiende.

Todo falla abierto: si no hay settings, si el verify no responde, si la config
está mal, el visitante pasa. Un conector que rompe el sitio del cliente es peor
que uno que no encola.

## Instalación

Hay dos caminos. Los dos terminan igual: dos funciones Lambda@Edge asociadas a un
behavior de CloudFront.

### A) Con CloudFormation (recomendado)

Un click abre la consola de AWS con todo cargado, en `us-east-1`:

> **[Launch Stack](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=https%3A%2F%2Fvirtual-queue-connector-releases.s3.amazonaws.com%2Freleases%2Flatest%2Ftemplate.yaml)**

Te pide dos datos:

- **Client**: el subdominio de tu compañía en VQueue (el mismo que usa el JS adapter).
- **PrivateKey**: la `private_key` de tu compañía.

El stack crea las dos funciones, su rol y un secreto de **Secrets Manager**
(`vqueue/connector`) donde queda tu clave. La clave **no viaja dentro de ningún
zip**: los zips de la release son idénticos para todos los clientes.

Cuando termina, en *Outputs* están los ARN de las dos versiones. Falta un solo
paso, que CloudFormation no puede hacer por vos: en CloudFront, editá el behavior
a proteger y agregá las dos asociaciones (**Viewer request** y **Viewer response**).

Para rotar la clave, editá el secreto `vqueue/connector`; las funciones lo toman en
a lo sumo 5 minutos.

### B) Descargando los zips

Bajá `viewer-request.zip` y `viewer-response.zip` de la última release (vienen sin
configurar), o armalos vos con tus datos:

```bash
npm install
npm run build -- --client <subdominio> --private-key <private_key>
```

Con ese build la config viaja dentro del bundle y quedan
`dist/viewer-request.zip` y `dist/viewer-response.zip`. El build empaqueta con el
`zip` del sistema (viene en macOS y Linux; en Windows, desde WSL o Git Bash).

Después, en AWS:

1. Crear dos funciones Lambda en **us-east-1** (Lambda@Edge solo se despliega
   desde ahí), runtime Node.js 22, y subir un zip en cada una.
2. Publicar una versión de cada función (Lambda@Edge no acepta `$LATEST`).
3. En la distribución de CloudFront, en el behavior a proteger, asociar:
   - **Viewer request** → la función viewer-request
   - **Viewer response** → la función viewer-response
4. **No** meter las cookies `vq_pass_*` / `vq_target_*` en la cache key del
   behavior. Las funciones viewer las ven siempre, sin importar la política de
   cache; incluirlas haría que cada visitante (su pase es único) fragmente el
   cache de CloudFront y nada se sirva cacheado. El origin tampoco las necesita.

### Sobre la clave

Lambda@Edge **no soporta variables de entorno**. Por eso la config viene de uno de
dos lugares: del secreto de Secrets Manager (camino A) o horneada en el bundle
(camino B). En el camino B el build la inyecta en memoria: `src/generated-config.js`
queda versionado solo con placeholders y la `private_key` nunca toca el árbol
fuente. Igual, tratá esos zips como material sensible.

Si no hay config válida de ninguno de los dos lados (secreto inexistente, sin
permiso, clave vacía), el conector arranca en fail-open: deja pasar todo y lo
informa en los logs, en vez de encolar con datos inventados.

### Borrar el stack

Una función Lambda@Edge no se puede borrar mientras CloudFront la tenga asociada, y
las réplicas tardan un rato en liberarse. Primero quitá las asociaciones del
behavior, esperá a que la distribución termine de desplegar, y recién ahí borrá el
stack. El secreto queda programado para borrarse y su nombre no se puede reusar
durante ese período.

## Por qué dos funciones

`viewer-request` puede devolver una respuesta propia (el 302 a la cola), pero **no
puede agregarle una cookie a una respuesta que viene del origin**. La renovación
deslizante necesita eso, y por eso existe `viewer-response`.

El puente entre ambas es un header interno (`x-vq-renew`) que viewer-request
agrega al request. Contrapartida conocida: ese header viaja al origin. Si el
visitante lo manda él mismo, viewer-request lo descarta antes de decidir nada:
nadie puede pedirle a viewer-response la cookie que quiera.

## Rendimiento y límites de Lambda@Edge

Un viewer-request tiene **5 s de timeout y 128 MB**, y si se pasa CloudFront le
devuelve un 503 al visitante. Medido en una función real:

- **Contenedor frío:** ~2.5 s (la primera llamada de red de un contenedor nuevo
  tarda ~2 s; después de eso, 100-400 ms por llamada).
- **Contenedor caliente:** 10-20 ms.

Por eso el conector tiene un presupuesto total de 4 s: si algo se cuelga (el
secreto, los settings), suelta al visitante en vez de dejar que expire el timeout.
Y por eso lee el secreto con una llamada firmada a mano y no con el SDK de AWS, cuyo
solo import tarda ~2.5 s a 128 MB.

## Contratos con VQueue

| Qué | Dónde | Autenticación |
|---|---|---|
| ACLs + URL de cola | `GET https://<admin>/api/v1/adapter/<client>/settings` | **Ninguna** (público, cacheable) |
| Canje del token | `GET <queue_url>/api/v1/queue/verify?token=` | Ninguna |
| Pase | cookie `vq_pass_<event_id>` | HMAC-SHA256 con `private_key`, offline |

El conector usa el endpoint **público** de settings, no `/api/v1/edge/config/`:
ese segundo es interno de la plataforma y requiere un token que no se entrega a
clientes.

El formato del pase es `VQueue.Lines.QueuePass`:
`base64url(json) "." base64url(hmac_sha256(private_key, base64url(json)))`, sin
padding, payload `{t, e, iat, exp}`. `core/test/pass.test.js` incluye un vector
firmado por la implementación real de VQueue: si alguno de los dos lados cambia el
formato, ese test se cae.

## Tests

```bash
npm test
```

## Limitaciones conocidas

- **El pase no está atado al visitante.** El payload de `QueuePass` no lleva IP ni
  User-Agent, así que es transferible entre visitantes de la misma compañía. Es un
  bearer credential: quien tiene la cookie, pasa.
- **El token de cola es de un solo uso**, con una ventana de gracia de 60s del
  lado de la API: si el canje falla justo después de marcarlo (timeout, loop de
  redirects en la CDN), el reintento inmediato vuelve a emitir el mismo pase.
  Pasada la ventana, el visitante tiene que hacer la fila de nuevo.
- **Solo un UUID es token de cola.** `?token=` y `?vq_token=` se reclaman
  únicamente con forma de UUID (es el id de la línea), igual que el JS adapter.
  Un `?token=` propio del sitio nunca cuesta un round trip a VQueue.
- **Sin protección automática.** Este conector no tiene sensores de carga; la
  activación es por regla (`enabled`).
