// Copia core/src a cloudflare-worker/vendor.
//
// El botón "Deploy to Cloudflare" clona SOLO esta carpeta, así que no puede
// resolver el workspace `@vqueue/connector-core`. La copia viaja con el worker y
// test/vendor-sync.test.js falla si se desincroniza de core.
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../core/src/", import.meta.url));
const to = fileURLToPath(new URL("../vendor/", import.meta.url));

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`core/src → cloudflare-worker/vendor`);
