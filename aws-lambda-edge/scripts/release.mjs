// Arma una release lista para subir al bucket.
//
//   node scripts/release.mjs --bucket <nombre-del-bucket> [--upload]
//
// Genera dist-release/releases/ con la estructura que espera el template:
//
//   releases/v<versión>/{template.yaml, viewer-request.zip, viewer-response.zip}
//   releases/latest/{template.yaml, viewer-request.zip, viewer-response.zip}
//
// Los zips salen SIN configurar: no llevan datos de ningún cliente, así que son
// seguros de publicar. La versión sale de package.json.
//
// Sin --upload solo arma la carpeta (se puede arrastrar a la consola de S3).

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-release");
const BUILD = path.join(OUT, ".build");

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, arg, i, all) => {
        if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]);
        return acc;
    }, []),
);

const bucket = args.bucket;
if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    console.error("Falta --bucket <nombre> (el bucket de S3 que aloja las releases).");
    process.exit(1);
}

const { version } = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

await rm(OUT, { recursive: true, force: true });
await mkdir(BUILD, { recursive: true });

await run("node", [path.join(ROOT, "scripts", "build.mjs"), "--unconfigured", "--out", BUILD]);

const template = (await readFile(path.join(ROOT, "cloudformation", "template.yaml"), "utf8"))
    .replaceAll("__VERSION__", version)
    .replaceAll("__BUCKET__", bucket);

if (template.includes("__VERSION__") || template.includes("__BUCKET__")) {
    throw new Error("el template quedó con placeholders sin reemplazar");
}

for (const folder of [`v${version}`, "latest"]) {
    const dir = path.join(OUT, "releases", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "template.yaml"), template);
    await cp(path.join(BUILD, "viewer-request.zip"), path.join(dir, "viewer-request.zip"));
    await cp(path.join(BUILD, "viewer-response.zip"), path.join(dir, "viewer-response.zip"));
}
await rm(BUILD, { recursive: true, force: true });

const base = `https://${bucket}.s3.amazonaws.com/releases`;
console.log(`Release v${version} armada en dist-release/releases/`);
console.log(`\nLaunch Stack (usa latest):`);
console.log(
    `https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?stackName=vqueue-connector&templateURL=${encodeURIComponent(`${base}/latest/template.yaml`)}`,
);

if (args.upload) {
    // Los zips de una versión son inmutables; `latest` no se cachea.
    await run("aws", ["s3", "cp", path.join(OUT, "releases", `v${version}`), `s3://${bucket}/releases/v${version}`, "--recursive"]);
    await run("aws", ["s3", "cp", path.join(OUT, "releases", "latest"), `s3://${bucket}/releases/latest`, "--recursive", "--cache-control", "no-cache"]);
    console.log("\nSubido.");
}
