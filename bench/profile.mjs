#!/usr/bin/env node
// Profile a scenario in an isolated child (CPU sampling or allocation sampling)
// and print the ranked report.
//
//   node bench/profile.mjs --cpu  decoder/tick [--build ./build] [--top 25] [--filter substr]
//   node bench/profile.mjs --heap decoder/tick/default [--build ./build]
//
// BENCH_PROFILE=1 makes the child multiply iterations ×10 and skip heap
// snapshots so samples dominate setup noise. Profiles land in bench/profiles/.
import { readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCpuProfile, printCpuReport } from "./lib/analyze-cpu.mjs";
import { analyzeHeapProfile, printHeapReport } from "./lib/analyze-heap.mjs";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(BENCH_DIR, "scenarios");
const PROFILES_DIR = join(BENCH_DIR, "profiles");
const CHILD = join(BENCH_DIR, "lib", "child.mjs");

const args = process.argv.slice(2);
const mode = args.includes("--heap") ? "heap" : "cpu";
const target = args.find((a) => !a.startsWith("--"));
const buildDir = args.includes("--build") ? resolve(args[args.indexOf("--build") + 1]) : resolve(BENCH_DIR, "..", "build");
const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 25;
const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;
if (!target) { console.error("usage: profile.mjs --cpu|--heap <scenario>[/<variant>] [--build dir]"); process.exit(1); }

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith(".mjs")) yield p;
    }
}

// resolve "encoder/steady-tick[/mut10]" -> scenario file + variant
let found = null;
for (const file of walk(SCENARIOS_DIR)) {
    const scenario = (await import(pathToFileURL(file).href)).default;
    const variants = (scenario.variants ?? [{ name: "default" }]).map((v) => v.name);
    if (target === scenario.name || target.startsWith(scenario.name + "/")) {
        const variant = target === scenario.name ? variants[0] : target.slice(scenario.name.length + 1);
        if (!variants.includes(variant)) { console.error(`unknown variant "${variant}" (have: ${variants.join(", ")})`); process.exit(1); }
        found = { file, scenario, variant };
        break;
    }
}
if (!found) { console.error(`no scenario matches "${target}"`); process.exit(1); }

mkdirSync(PROFILES_DIR, { recursive: true });
const profName = `${found.scenario.name.replace(/\//g, "__")}__${found.variant}.${mode === "cpu" ? "cpuprofile" : "heapprofile"}`;

const nodeArgs = mode === "cpu"
    ? ["--cpu-prof", "--cpu-prof-dir", PROFILES_DIR, "--cpu-prof-name", profName]
    : ["--heap-prof", "--heap-prof-dir", PROFILES_DIR, "--heap-prof-name", profName, "--heap-prof-interval", "32768"];

console.error(`profiling (${mode}) ${found.scenario.name}/${found.variant} against ${buildDir} ...`);
const res = spawnSync(process.execPath, ["--expose-gc", ...nodeArgs, CHILD, found.file, found.variant, buildDir], {
    encoding: "utf8",
    timeout: 15 * 60_000,
    env: { ...process.env, BENCH_PROFILE: "1" },
});
if (res.status !== 0) { console.error(`child failed:\n${res.stderr}`); process.exit(1); }
console.error(res.stdout.trim());

const profPath = join(PROFILES_DIR, profName);
const profile = JSON.parse(readFileSync(profPath, "utf8"));
console.log(`\nprofile: ${profPath}\n`);
if (mode === "cpu") printCpuReport(analyzeCpuProfile(profile), { top, filter });
else printHeapReport(analyzeHeapProfile(profile), { top, filter });
