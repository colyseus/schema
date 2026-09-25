// Packaging smoke test: load every `exports` subpath of the BUILT package
// under both the `require` (CJS) and `import` (ESM) conditions.
//
// Guards the bug where the CJS `./input` bundle externalized its dependencies
// to relative paths (`../encoding/spec.js`, ...) that were never emitted, so
// `require('@colyseus/schema/input')` crashed any CommonJS server on boot with
// "Cannot find module". Resolution uses Node package self-reference, so this
// exercises the real `exports` map + condition resolution, not a hand-built path.
//
// Run AFTER `npm run build` (it loads `build/*`). Exits non-zero on any failure.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(new TextDecoder().decode(readFileSync(new URL("../package.json", import.meta.url))));

const specifiers = Object.keys(pkg.exports).map((sub) =>
  sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`,
);

const hasExports = (m) => m && Object.keys(m).length > 0;
let failed = 0;

for (const spec of specifiers) {
  // `require` condition → resolves the `.cjs` artifacts.
  try {
    if (!hasExports(require(spec))) throw new Error("loaded but has no exports");
    console.log(`  require ${spec} — OK`);
  } catch (err) {
    failed++;
    console.error(`  require ${spec} — FAIL: ${err.message}`);
  }

  // `import` condition → resolves the `.mjs` artifacts.
  try {
    if (!hasExports(await import(spec))) throw new Error("loaded but has no exports");
    console.log(`  import  ${spec} — OK`);
  } catch (err) {
    failed++;
    console.error(`  import  ${spec} — FAIL: ${err.message}`);
  }
}

// Subpath bundles resolve their dependencies from the package entry (see
// rollup.config.mjs). A name the entry does not export fails the ESM import
// above, but under `require` it is silently `undefined` until first use — so
// check every such name against the entry's exports explicitly.
const main = require(pkg.name);
for (const file of ["../build/input/index.mjs"]) {
  const code = new TextDecoder().decode(readFileSync(new URL(file, import.meta.url)));
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@colyseus\/schema["']/g)) {
    for (const spec of m[1].split(",")) {
      const name = spec.trim().split(/\s+as\s+/)[0];
      if (name && !(name in main)) {
        failed++;
        console.error(`  ${file} imports "${name}" — not exported by ${pkg.name}`);
      }
    }
  }
}

if (failed > 0) {
  console.error(`\nverify-exports: ${failed} check(s) failed across ${specifiers.length} subpath(s).`);
  process.exit(1);
}
console.log(`\nverify-exports: all ${specifiers.length} subpath(s) load under require + import.`);
