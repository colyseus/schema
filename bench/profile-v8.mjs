#!/usr/bin/env node
// V8-level profiling of one bench unit: deopts, inline-cache states, inlining
// decisions, hidden-class checks. Companion to profile.mjs (CPU / heap sampling).
//
//   node bench/profile-v8.mjs --deopt    <scenario>[/<variant>] [--build dir] [--iters N] [--top N] [--all]
//   node bench/profile-v8.mjs --ic       <scenario>[/<variant>] [--build dir] [--iters 200] [--top N] [--all] [--state N|P|G]
//   node bench/profile-v8.mjs --inlining <scenario>[/<variant>] [--build dir] [--iters N] --fn <name>
//   node bench/profile-v8.mjs --shapes   [--build dir]
//
// The child is bench/lib/child.mjs with BENCH_PROFILE=1, one rep, and an
// explicit iteration count (deopts and IC transitions happen during warm-up;
// --ic in particular needs few iterations — the log grows by ~100 MB/s).
// Raw logs land in bench/profiles/<scenario>__<variant>.<mode>.log; the child's
// JSON result is the last stdout line and is echoed to stderr.
//
// Windows notes: `--logfile` must be an absolute path with forward slashes in an
// existing directory, plus `--no-logfile-per-isolate`, or V8 writes
// isolate-<addr>-<pid>-v8.log into the cwd. All trace flags print to stdout.
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDeoptLog, printDeoptReport } from "./lib/analyze-deopt.mjs";
import { parseIcLog, printIcReport } from "./lib/analyze-ic.mjs";
import { parseInliningLog, printInliningReport } from "./lib/analyze-inlining.mjs";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(BENCH_DIR, "scenarios");
const PROFILES_DIR = join(BENCH_DIR, "profiles");
const CHILD = join(BENCH_DIR, "lib", "child.mjs");

const args = process.argv.slice(2);
const mode = ["--deopt", "--ic", "--inlining", "--shapes"].find((m) => args.includes(m))?.slice(2);
const opt = (name, dflt) => args.includes(name) ? args[args.indexOf(name) + 1] : dflt;
const target = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--build", "--iters", "--top", "--fn", "--state"].includes(args[i - 1])));
const buildDir = resolve(opt("--build", resolve(BENCH_DIR, "..", "build")));
const top = +opt("--top", mode === "ic" ? 40 : 30);
const all = args.includes("--all");
if (!mode) { console.error("usage: profile-v8.mjs --deopt|--ic|--inlining <scenario>[/<variant>] | --shapes  [--build dir]"); process.exit(1); }

mkdirSync(PROFILES_DIR, { recursive: true });

if (mode === "shapes") {
    const res = spawnSync(process.execPath, ["--allow-natives-syntax", join(BENCH_DIR, "lib", "shape-check.mjs"), buildDir, ...(args.includes("--debug-print") ? ["--debug-print", opt("--debug-print")] : [])], { encoding: "utf8", stdio: "inherit" });
    process.exit(res.status ?? 1);
}

if (!target) { console.error("missing <scenario>[/<variant>]"); process.exit(1); }

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith(".mjs")) yield p;
    }
}
let found = null;
for (const file of walk(SCENARIOS_DIR)) {
    const scenario = (await import(pathToFileURL(file).href)).default;
    const variants = scenario.variants ?? [{ name: "default" }];
    if (target === scenario.name || target.startsWith(scenario.name + "/")) {
        const variantName = target === scenario.name ? variants[0].name : target.slice(scenario.name.length + 1);
        const variant = variants.find((v) => v.name === variantName);
        if (!variant) { console.error(`unknown variant "${variantName}" (have: ${variants.map((v) => v.name).join(", ")})`); process.exit(1); }
        found = { file, scenario, variant };
        break;
    }
}
if (!found) { console.error(`no scenario matches "${target}"`); process.exit(1); }

const baseName = `${found.scenario.name.replace(/\//g, "__")}__${found.variant.name}`;
const defaultIters = found.variant.iterations ?? found.scenario.iterations ?? 1000;
const iters = +opt("--iters", mode === "ic" ? Math.min(200, defaultIters) : defaultIters);
const logPath = join(PROFILES_DIR, `${baseName}.${mode === "ic" ? "v8.log" : mode + ".log"}`);

let nodeArgs;
if (mode === "deopt") nodeArgs = ["--trace-deopt-verbose", "--trace-opt"];
else if (mode === "ic") nodeArgs = ["--log-ic", "--log-code", `--logfile=${logPath.replace(/\\/g, "/")}`, "--no-logfile-per-isolate"];
else nodeArgs = ["--trace-turbo-inlining", "--trace-opt", "--no-concurrent-recompilation"];

console.error(`v8 ${mode}: ${found.scenario.name}/${found.variant.name} against ${buildDir} (1 rep × ${iters} iterations) ...`);
const res = spawnSync(process.execPath, ["--expose-gc", ...(found.scenario.nodeFlags ?? []), ...nodeArgs, CHILD, found.file, found.variant.name, buildDir, "1", String(iters)], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024 * 1024,
    timeout: 15 * 60_000,
    env: { ...process.env, BENCH_PROFILE: "1" },
});
if (res.status !== 0) { console.error(`child failed:\n${res.stderr}`); process.exit(1); }
const lines = res.stdout.split(/\r?\n/).filter((l) => l.length > 0);
const resultLine = res.stdout.match(/{"scenario":.*}/)?.[0];
console.error(resultLine ?? "(no result line)");

if (mode !== "ic") writeFileSync(logPath, res.stdout);
console.log(`\nlog: ${logPath}\n`);

if (mode === "deopt") printDeoptReport(parseDeoptLog(res.stdout), { top, all });
else if (mode === "ic") printIcReport(parseIcLog(readFileSync(logPath, "utf8")), { top, all, state: opt("--state", null) });
else printInliningReport(parseInliningLog(res.stdout), { fn: opt("--fn", null), top });
