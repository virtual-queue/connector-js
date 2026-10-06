// Empaqueta las dos lambdas con la config del cliente horneada adentro.
//
// Lambda@Edge no soporta variables de entorno, así que el `client` y el
// `privateKey` tienen que viajar dentro del bundle. Este script los inyecta y
// produce un .zip por función, listo para subir.
//
//   node scripts/build.mjs --client orome --private-key <clave> [--admin-host ...] [--debug]
//   node scripts/build.mjs --unconfigured [--out dist]
//
// El resultado queda en dist/: viewer-request.zip y viewer-response.zip
//
// `--unconfigured` arma el bundle SIN datos del cliente: es el que se publica en
// las releases y el que instala el template de CloudFormation, que guarda el
// subdominio y la clave en AWS Secrets Manager y no dentro del zip.

import { build } from "esbuild";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
            args[key] = next;
            i++;
        } else {
            args[key] = true;
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const UNCONFIGURED = args.unconfigured === true;
const DIST = path.resolve(ROOT, typeof args.out === "string" ? args.out : "dist");

if (!UNCONFIGURED && (!args.client || !args["private-key"])) {
    console.error(`
Falta configuración.

  node scripts/build.mjs --client <subdominio> --private-key <private_key>
  node scripts/build.mjs --unconfigured      (la config sale de AWS Secrets Manager)

  --client        Subdominio de la compañía en VQueue (el mismo que usa el JS adapter)
  --private-key   private_key de la compañía. Es el secreto con el que VQueue
                  firma el pase; queda dentro del bundle, en el AWS del cliente.
  --admin-host    Default: clients.virtual-queue.com
  --debug         Logs verbosos (NO usar en producción: son por request)
`);
    process.exit(1);
}

const config = UNCONFIGURED ? null : {
    client: args.client,
    privateKey: args["private-key"],
    adminHost: args["admin-host"] || "clients.virtual-queue.com",
    settingsTtlMs: 30_000,
    settingsTimeoutMs: 1_500,
    verifyTimeoutMs: 2_000,
    deadlineMs: 4_000,
    debug: args.debug === true,
};

// Inyecta la config en tiempo de bundle SIN tocar el árbol fuente.
//
// Dos cosas que se probaron y no sirven:
//   - Post-procesar el bundle con un reemplazo de texto: esbuild reescribe el
//     código al pasar a CJS (`const` → `var`), y el reemplazo falla en silencio
//     dejando el bundle sin configurar.
//   - Escribir src/generated-config.js: deja la private_key del cliente en un
//     archivo versionado, listo para filtrarse en el primer commit.
//
// El plugin resuelve el import en memoria: la clave solo existe dentro de dist/.
function configPlugin() {
    return {
        name: "vq-config",
        setup(buildApi) {
            buildApi.onResolve({ filter: /generated-config\.js$/ }, () => ({
                path: "vq-generated-config",
                namespace: "vq-config",
            }));

            buildApi.onLoad({ filter: /.*/, namespace: "vq-config" }, () => ({
                contents: `export const CONFIG = ${JSON.stringify(config)};`,
                loader: "js",
            }));
        },
    };
}

// Red de seguridad: un bundle a medio configurar es peor que un build que falla,
// porque se despacharía al cliente con `__VQ_PRIVATE_KEY__` adentro.
async function assertNoPlaceholders(outfile, name) {
    const code = await readFile(outfile, "utf8");
    const leftover = code.match(/__VQ_[A-Z_]+__/);
    if (leftover) {
        throw new Error(`${name}: quedó un placeholder sin reemplazar (${leftover[0]})`);
    }
}

// Lo contrario para el bundle sin configurar: tiene que tener los placeholders
// (para que arranque leyendo Secrets Manager) y NINGÚN dato de un cliente.
async function assertUnconfigured(outfile, name) {
    if (name !== "viewer-request") return; // viewer-response no usa la config
    const code = await readFile(outfile, "utf8");
    if (!code.includes("__VQ_PRIVATE_KEY__")) {
        throw new Error(`${name}: el bundle sin configurar perdió los placeholders`);
    }
}

async function bundle(name) {
    const outfile = path.join(DIST, name, "index.js");

    await build({
        entryPoints: [path.join(ROOT, "src", name, "index.js")],
        outfile,
        bundle: true,
        platform: "node",
        target: "node20",
        // Lambda@Edge espera CommonJS con `exports.handler`.
        format: "cjs",
        minify: false, // legible: el cliente lo audita antes de instalarlo
        plugins: UNCONFIGURED ? [] : [configPlugin()],
        banner: { js: `// VQueue connector — ${name} — ${UNCONFIGURED ? "sin configurar (Secrets Manager)" : `client: ${config.client}`}` },
    });

    if (UNCONFIGURED) await assertUnconfigured(outfile, name);
    else await assertNoPlaceholders(outfile, name);

    // zip con el index.js en la raíz, que es lo que pide Lambda.
    await execFileAsync("zip", ["-q", "-j", path.join(DIST, `${name}.zip`), outfile]);
    console.log(`  ✓ dist/${name}.zip`);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "viewer-request"), { recursive: true });
await mkdir(path.join(DIST, "viewer-response"), { recursive: true });

console.log(UNCONFIGURED
    ? "Empaquetando SIN configurar (la config se lee de Secrets Manager)"
    : `Empaquetando para client=${config.client} (admin: ${config.adminHost})`);
await bundle("viewer-request");
await bundle("viewer-response");
console.log(`\nListo. Subí cada zip a su Lambda y asociá las funciones a la
distribución de CloudFront en los eventos viewer-request y viewer-response.`);
