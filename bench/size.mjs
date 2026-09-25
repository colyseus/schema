#!/usr/bin/env node
/**
 * Bundle-size report: what a consumer's bundler ships after tree-shaking and
 * minification, gzip -9 and brotli. Default pipeline = Vite's production
 * build: rollup tree-shaking + esbuild minify (esbuild is the copy tsx already
 * depends on). `--esbuild` bundles with esbuild instead (esbuild / bun users):
 * esbuild keeps every class that has a static field or a computed member key,
 * so it drops next to nothing from this library.
 *
 *   node bench/size.mjs                      # build/index.mjs
 *   node bench/size.mjs bench/.builds/v5-release bench/.builds/S0-base build
 *   node bench/size.mjs --attribute [full|client]   # minified bytes per src file
 *   node bench/size.mjs --gate               # assert bench/size-budget.json
 *
 * Targets:
 *   full   — `export *` of the package entry (the server / everything case)
 *   client — the names a browser client imports (decoder side only)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsx"))("esbuild");

// What the colyseus SDK imports (colyseus/packages/sdk/src) plus `type` for
// the app's own state classes. The SDK's dist bundle is built with rollup.
const CLIENT_IMPORTS = [
    "Decoder", "Reflection", "Schema", "type", "Metadata",
    "MapSchema", "ArraySchema", "SetSchema",
    "Callbacks", "getDecoderStateCallbacks",
    "decode", "encode", "$refId", "$values",
];

// Encoder-only internals: none of them may reach a client bundle.
const CLIENT_FORBIDDEN = ["dirtyLow", "encDescriptor", "unreliableRecorder", "buffer overflow"];

const TARGETS = {
    full: (entry) => `export * from ${JSON.stringify(entry)};`,
    client: (entry) => `export { ${CLIENT_IMPORTS.join(", ")} } from ${JSON.stringify(entry)};`,
};

const VIRTUAL = "\0size-entry";
let useEsbuild = false;

function resolveEntry(arg) {
    const p = path.resolve(ROOT, arg);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { return path.join(p, "index.mjs"); }
    return p;
}

async function esbuildBundle(contents, extra = {}) {
    return esbuild.build({
        stdin: { contents, resolveDir: ROOT, loader: "js" },
        bundle: true,
        minify: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
        ...extra,
    });
}

/** Tree-shake with rollup (as Vite does), then minify with esbuild. */
async function bundleCode(contents) {
    if (useEsbuild) { return (await esbuildBundle(contents)).outputFiles[0].text; }
    const build = await rollup({
        input: VIRTUAL,
        onwarn: () => {},
        plugins: [{
            name: "size-entry",
            resolveId: (id) => (id === VIRTUAL ? id : null),
            load: (id) => (id === VIRTUAL ? contents : null),
        }],
    });
    const { output } = await build.generate({ format: "esm" });
    await build.close();
    return (await esbuild.transform(output[0].code, { minify: true, format: "esm", target: "es2022" })).code;
}

function measure(code) {
    const buf = Buffer.from(code);
    return {
        min: buf.length,
        gzip: zlib.gzipSync(buf, { level: 9 }).length,
        brotli: zlib.brotliCompressSync(buf, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
    };
}

async function sizesOf(entry) {
    const out = {};
    for (const [name, make] of Object.entries(TARGETS)) {
        const code = await bundleCode(make(entry.replace(/\\/g, "/")));
        out[name] = measure(code);
        if (name === "client") {
            out[name].forbidden = CLIENT_FORBIDDEN.filter((s) => code.includes(s));
        }
    }
    return out;
}

/**
 * Minified bytes per source file after tree-shaking: rollup over src/ with
 * `preserveModules` (one output chunk per surviving .ts file), each chunk
 * minified with esbuild. Chunks keep their import/export glue, so the total
 * runs a little above the single-bundle size.
 */
async function attribute(target) {
    const make = TARGETS[target];
    if (!make) { throw new Error(`unknown target ${target}`); }
    const typescript = (await import("@rollup/plugin-typescript")).default;
    const build = await rollup({
        input: VIRTUAL,
        onwarn: () => {},
        plugins: [
            {
                name: "size-entry",
                resolveId: (id) => (id === VIRTUAL ? id : null),
                load: (id) => (id === VIRTUAL ? make(path.join(ROOT, "src/index.ts").replace(/\\/g, "/")) : null),
            },
            typescript({ tsconfig: path.join(ROOT, "tsconfig/tsconfig.esm.json"), noEmitOnError: false, sourceMap: false, inlineSources: false }),
        ],
    });
    const { output } = await build.generate({ format: "esm", preserveModules: true, preserveModulesRoot: path.join(ROOT, "src") });
    await build.close();
    const rows = [];
    for (const chunk of output) {
        if (chunk.type !== "chunk" || !chunk.facadeModuleId || chunk.facadeModuleId === VIRTUAL) { continue; }
        const min = (await esbuild.transform(chunk.code, { minify: true, format: "esm", target: "es2022" })).code;
        rows.push([path.relative(ROOT, chunk.facadeModuleId).replace(/\\/g, "/"), Buffer.byteLength(min)]);
    }
    rows.sort((x, y) => y[1] - x[1]);
    const total = rows.reduce((t, r) => t + r[1], 0);
    for (const [file, bytes] of rows) {
        console.log(`${String(bytes).padStart(7)} ${(100 * bytes / total).toFixed(1).padStart(5)}%  ${file}`);
    }
    console.log(`${String(total).padStart(7)}  total (${target}, per-module minified, pre-gzip)`);
}

const kb = (n) => (n / 1024).toFixed(1).padStart(6);

async function main() {
    const args = process.argv.slice(2);
    const attrIdx = args.indexOf("--attribute");
    if (attrIdx !== -1) {
        const t = args[attrIdx + 1];
        return attribute(t && !t.startsWith("--") ? t : "full");
    }
    useEsbuild = args.includes("--esbuild");
    const gate = args.includes("--gate");
    const json = args.includes("--json");
    const builds = args.filter((a) => !a.startsWith("--"));
    if (builds.length === 0) { builds.push("build"); }

    const results = {};
    for (const b of builds) { results[b] = await sizesOf(resolveEntry(b)); }

    if (json) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        const pipeline = useEsbuild ? "esbuild bundle+minify" : "rollup + esbuild minify";
        console.log(`KB (${pipeline})`.padEnd(34) + "  full: min   gzip brotli | client: min   gzip brotli");
        for (const [b, r] of Object.entries(results)) {
            const f = r.full, c = r.client;
            const warn = c.forbidden.length ? `  encoder leaks: ${c.forbidden.join(", ")}` : "";
            console.log(`${b.padEnd(34)} ${kb(f.min)} ${kb(f.gzip)} ${kb(f.brotli)} | ${kb(c.min)} ${kb(c.gzip)} ${kb(c.brotli)}${warn}`);
        }
    }

    if (gate) {
        const budget = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/size-budget.json"), "utf8"));
        const r = results[builds[builds.length - 1]];
        const failures = [];
        for (const [target, limits] of Object.entries(budget)) {
            if (target.startsWith("//")) { continue; }
            for (const [metric, max] of Object.entries(limits)) {
                if (metric === "forbidden") {
                    if (max === false && r[target].forbidden?.length) {
                        failures.push(`${target}: encoder internals present (${r[target].forbidden.join(", ")})`);
                    }
                } else if (r[target][metric] > max) {
                    failures.push(`${target}.${metric} ${r[target][metric]} > budget ${max}`);
                }
            }
        }
        if (failures.length) {
            console.error("size gate FAILED:\n  " + failures.join("\n  "));
            process.exit(1);
        }
        console.log("size gate ok");
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
