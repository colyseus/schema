// Packaging smoke test: load every `exports` subpath of the BUILT package
// under both the `require` (CJS) and `import` (ESM) conditions.
//
// Guards the bug where the CJS `./input` bundle externalized its dependencies
// to relative paths (`../encoding/spec.js`, ...) that were never emitted, so
// `require('@colyseus/schema/input')` crashed any CommonJS server on boot with
// "Cannot find module". Resolution uses Node package self-reference, so this
// exercises the real `exports` map + condition resolution, not a hand-built path.
//
// Also guards the dual-package hazard: where Node supports `require(esm)`, the
// `module-sync` condition must send `require()` to the same `.mjs` instance
// `import` gets. Otherwise a CommonJS server holds one copy while the ESM
// builds of `@colyseus/core` & co. hold another, and statics such as
// `Encoder.BUFFER_SIZE` set by the app never reach the encoder in use.
//
// Run AFTER `npm run build` (it loads `build/*`). Exits non-zero on any failure.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const requireEsm = process.features.require_module === true;
const pkg = JSON.parse(new TextDecoder().decode(readFileSync(new URL("../package.json", import.meta.url))));

const specifiers = Object.keys(pkg.exports).map((sub) =>
  sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`,
);

const hasExports = (m) => m && Object.keys(m).length > 0;
let failed = 0;

for (const spec of specifiers) {
  let required, imported;

  // `require` condition → the `.cjs` artifacts, or `.mjs` under `module-sync`.
  try {
    required = require(spec);
    if (!hasExports(required)) throw new Error("loaded but has no exports");
    console.log(`  require ${spec} — OK`);
  } catch (err) {
    failed++;
    console.error(`  require ${spec} — FAIL: ${err.message}`);
  }

  // `import` condition → resolves the `.mjs` artifacts.
  try {
    imported = await import(spec);
    if (!hasExports(imported)) throw new Error("loaded but has no exports");
    console.log(`  import  ${spec} — OK`);
  } catch (err) {
    failed++;
    console.error(`  import  ${spec} — FAIL: ${err.message}`);
  }

  if (requireEsm && required && imported) {
    const split = Object.keys(imported).filter((key) => required[key] !== imported[key]);
    if (split.length > 0) {
      failed++;
      console.error(`  shared  ${spec} — FAIL: require() and import load separate instances (${split.length} exports differ, e.g. "${split[0]}")`);
    } else {
      console.log(`  shared  ${spec} — OK`);
    }
  }
}

// `module-sync` took require() away from the `.cjs` artifacts above; load them
// the way a Node without require(esm) does.
if (requireEsm) {
  console.log("\n  --no-experimental-require-module:");
  const child = spawnSync(
    process.execPath,
    ["--no-experimental-require-module", fileURLToPath(import.meta.url)],
    { stdio: "inherit" },
  );
  if (child.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\nverify-exports: ${failed} check(s) failed across ${specifiers.length} subpath(s).`);
  process.exit(1);
}
console.log(`\nverify-exports: all ${specifiers.length} subpath(s) load under require + import.`);
