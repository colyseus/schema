#!/usr/bin/env node
// Benchmark runner. Each sample = one isolated child process (bench/lib/child.mjs).
//
//   Single build:  node bench/run.mjs [--filter <pat>] [--samples 5] [--build ./build] [--json out]
//   A/B compare:   node bench/run.mjs --compare <dirA> <dirB> --samples 20 [--filter <pat>] [--json out]
//   Budget gate:   node bench/run.mjs --assert [--filter gate] [--samples 3] [--build ./build]
//
// Compare mode interleaves A,B,A,B... per scenario and reports Mann-Whitney U
// p-values for BOTH wall-clock and GC time. `--filter gate` selects gate-tagged
// scenarios; otherwise the pattern matches "scenario-name/variant" (supports *).
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median, iqr, mannWhitneyU, hlShift } from "./lib/stats.mjs";
import { printTable, fmtNum, fmtDelta, fmtP } from "./lib/report.mjs";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(BENCH_DIR, "scenarios");
const CHILD = join(BENCH_DIR, "lib", "child.mjs");

// --- args ---
const argv = process.argv.slice(2);
const opts = { samples: null, build: resolve(BENCH_DIR, "..", "build"), filter: null, json: null, compare: null, assert: false, reps: null, iters: null };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compare") { opts.compare = [resolve(argv[++i]), resolve(argv[++i])]; }
    else if (a === "--samples") opts.samples = +argv[++i];
    else if (a === "--build") opts.build = resolve(argv[++i]);
    else if (a === "--filter") opts.filter = argv[++i];
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--assert") opts.assert = true;
    else if (a === "--reps") opts.reps = +argv[++i];
    else if (a === "--iters") opts.iters = +argv[++i];
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
}
opts.samples ??= opts.compare ? 20 : 5;

// --- discover scenarios ---
function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith(".mjs")) yield p;
    }
}

function matchesFilter(scenario, variantName) {
    if (!opts.filter) return true;
    if (opts.filter === "gate") return scenario.gate === true;
    const full = `${scenario.name}/${variantName}`;
    const re = new RegExp("^" + opts.filter.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
    return re.test(full) || re.test(scenario.name);
}

const units = [];
for (const file of walk(SCENARIOS_DIR)) {
    const scenario = (await import(pathToFileURL(file).href)).default;
    for (const variant of scenario.variants ?? [{ name: "default" }]) {
        if (matchesFilter(scenario, variant.name)) units.push({ file, scenario, variant: variant.name });
    }
}
if (units.length === 0) { console.error("no scenarios match filter"); process.exit(1); }

// --- sample runner ---
function runSample(unit, buildDir) {
    const args = ["--expose-gc", CHILD, unit.file, unit.variant, buildDir];
    if (opts.reps) args.push(String(opts.reps));
    if (opts.iters) { if (!opts.reps) args.push(String(unit.scenario.reps ?? 7)); args.push(String(opts.iters)); }
    const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10 * 60_000 });
    if (res.status !== 0) {
        console.error(`\nchild failed: ${unit.scenario.name}/${unit.variant} (${buildDir})\n${res.stderr}`);
        process.exit(1);
    }
    const line = res.stdout.trim().split("\n").pop();
    try { return JSON.parse(line); } catch {
        console.error(`\nbad child output for ${unit.scenario.name}/${unit.variant}:\n${res.stdout}\n${res.stderr}`);
        process.exit(1);
    }
}

const meta = {
    date: new Date().toISOString(),
    node: process.version,
    gitSha: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: BENCH_DIR, encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
    samples: opts.samples,
    filter: opts.filter,
};

function writeJson(payload) {
    if (!opts.json) return;
    mkdirSync(dirname(resolve(opts.json)), { recursive: true });
    writeFileSync(resolve(opts.json), JSON.stringify(payload, null, 2));
    console.log(`\nwrote ${opts.json}`);
}

function progress(msg) { process.stderr.write(msg); }

// --- compare mode ---
if (opts.compare) {
    const [dirA, dirB] = opts.compare;
    console.log(`compare A=${dirA}  B=${dirB}  samples=${opts.samples}/side (interleaved)\n`);
    const rows = [["scenario/variant", "unit", "A med", "B med", "Δ%", "p", "gcMs A→B", "p(gc)", "heapKb A→B", "bytes", ""]];
    const jsonRows = [];

    for (const unit of units) {
        const A = { values: [], gcMs: [], heapKb: [], bytes: new Set() };
        const B = { values: [], gcMs: [], heapKb: [], bytes: new Set() };
        progress(`${unit.scenario.name}/${unit.variant} `);
        // discard one warm pair (fs/process caches), then ABBA ordering so
        // within-pair drift cancels instead of biasing the side that runs second
        runSample(unit, dirA); runSample(unit, dirB);
        for (let s = 0; s < opts.samples; s++) {
            const aFirst = s % 2 === 0;
            const r1 = runSample(unit, aFirst ? dirA : dirB);
            const r2 = runSample(unit, aFirst ? dirB : dirA);
            const [ra, rb] = aFirst ? [r1, r2] : [r2, r1];
            A.values.push(ra.value); A.gcMs.push(ra.gc.totalMs); A.heapKb.push(ra.heapDeltaKb); A.bytes.add(ra.bytesPerOp);
            B.values.push(rb.value); B.gcMs.push(rb.gc.totalMs); B.heapKb.push(rb.heapDeltaKb); B.bytes.add(rb.bytesPerOp);
            progress(".");
        }
        progress("\n");

        const medA = median(A.values), medB = median(B.values);
        const deltaPct = ((medB - medA) / medA) * 100;
        const mwValue = mannWhitneyU(A.values, B.values);
        const mwGc = mannWhitneyU(A.gcMs, B.gcMs);
        const gcA = median(A.gcMs), gcB = median(B.gcMs);
        const sig = mwValue.p < 0.05;
        const gcOnly = !sig && mwGc.p < 0.05 && gcA !== gcB;
        const bytesA = [...A.bytes].join(","), bytesB = [...B.bytes].join(",");
        const bytesNote = bytesA === bytesB ? bytesA : `A:${bytesA}≠B:${bytesB} !!`;

        rows.push([
            `${unit.scenario.name}/${unit.variant}`,
            unit.scenario.unit ?? "ms/op",
            fmtNum(medA), fmtNum(medB), fmtDelta(deltaPct), fmtP(mwValue.p),
            `${fmtNum(gcA, 3)}→${fmtNum(gcB, 3)}`, fmtP(mwGc.p),
            `${fmtNum(median(A.heapKb), 3)}→${fmtNum(median(B.heapKb), 3)}`,
            bytesNote,
            sig ? (deltaPct < 0 ? "✓ faster" : "✗ SLOWER") : gcOnly ? "≈ gc-only" : "",
        ]);
        jsonRows.push({
            scenario: unit.scenario.name, variant: unit.variant,
            a: { median: medA, values: A.values, gcMs: A.gcMs, heapKb: A.heapKb },
            b: { median: medB, values: B.values, gcMs: B.gcMs, heapKb: B.heapKb },
            deltaPct, p: mwValue.p, pGc: mwGc.p, hlShift: hlShift(A.values, B.values),
            bytesA, bytesB,
        });
    }

    console.log("");
    printTable(rows);
    console.log("\n✓/✗ = wall-clock p<0.05; '≈ gc-only' = GC differs at p<0.05 with wall-clock neutral; Δ%<0 means B faster.");
    writeJson({ meta: { ...meta, mode: "compare", dirA, dirB }, rows: jsonRows });
    process.exit(0);
}

// --- single mode (with optional --assert budget gate) ---
console.log(`build=${opts.build}  samples=${opts.samples}\n`);
const rows = [["scenario/variant", "unit", "median", "IQR", "gcMs", "gc#", "heapKb", "bytes/op"]];
const jsonRows = [];
const failures = [];

for (const unit of units) {
    const samples = [];
    progress(`${unit.scenario.name}/${unit.variant} `);
    for (let s = 0; s < opts.samples; s++) { samples.push(runSample(unit, opts.build)); progress("."); }
    progress("\n");

    const values = samples.map((s) => s.value);
    const med = median(values);
    rows.push([
        `${unit.scenario.name}/${unit.variant}`,
        samples[0].unit,
        fmtNum(med),
        fmtNum(iqr(values), 3),
        fmtNum(median(samples.map((s) => s.gc.totalMs)), 3),
        String(Math.round(median(samples.map((s) => s.gc.count)))),
        fmtNum(median(samples.map((s) => s.heapDeltaKb)), 3),
        samples[0].bytesPerOp ?? "-",
    ]);
    jsonRows.push({
        scenario: unit.scenario.name, variant: unit.variant, unit: samples[0].unit,
        median: med, values, gc: samples.map((s) => s.gc), heapKb: samples.map((s) => s.heapDeltaKb),
        bytesPerOp: samples[0].bytesPerOp,
    });

    const budget = unit.scenario.budget?.[unit.variant];
    if (opts.assert && budget !== undefined && med > budget) {
        failures.push(`${unit.scenario.name}/${unit.variant}: median ${fmtNum(med)} > budget ${budget}`);
    }
}

console.log("");
printTable(rows);
writeJson({ meta: { ...meta, mode: "single", build: opts.build }, rows: jsonRows });

if (opts.assert) {
    if (failures.length) {
        console.error(`\nBUDGET FAILURES:\n  ${failures.join("\n  ")}`);
        process.exit(1);
    }
    console.log("\nall budgets OK");
}
