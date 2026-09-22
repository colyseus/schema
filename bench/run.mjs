#!/usr/bin/env node
// Benchmark runner. Each sample = one isolated child process (bench/lib/child.mjs).
//
//   Single build:  node bench/run.mjs [--filter <pat>[,<pat>…]] [--samples 5] [--build ./build] [--json out]
//   A/B compare:   node bench/run.mjs --compare <dirA> <dirB> --samples 20 [--filter <pat>] [--json out]
//   Bisect:        node bench/run.mjs --bisect <base> <b1> <b2> … --samples 8 --filter <pat>
//   Budget gate:   node bench/run.mjs --assert [--filter gate] [--samples 3] [--build ./build]
//
// Common options:
//   --filter a,b     comma list (or repeat the flag); a unit runs if ANY pattern
//                    matches "scenario-name/variant" or "scenario-name" (supports *).
//                    `gate` selects gate-tagged scenarios.
//   --warmup N       warm-up run count for every unit (overrides the scenario's
//                    `warmup` AND the minimum warm-up time below).
//   --min-warmup-ms M  minimum warm-up TIME per sample (default 100; 0 = off,
//                    i.e. the scenario counts only). A unit whose calibration
//                    sample warmed up for less gets its warm-up count raised to
//                    ceil(M / steady ms-per-run), the same count on both sides.
//   --pad / --no-pad force heap-layout randomisation on for every unit / off.
//                    Default: on for units marked `layoutSensitive`.
//   --no-aa          compare/bisect: don't re-run flagged rows as A-vs-A.
//   --reps N, --iters N  override the scenario's reps / iterations.
//
// Compare mode interleaves A,B,A,B... per scenario and reports Mann-Whitney U
// p-values for BOTH wall-clock and GC time. A flagged row (p < 0.05) is re-run
// as base-vs-base and the A/A Δ% (p) is printed next to it: a flag whose A/A is
// as large is noise.
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median, iqr, mannWhitneyU, hlShift, bimodal } from "./lib/stats.mjs";
import { printTable, fmtNum, fmtDelta, fmtP } from "./lib/report.mjs";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(BENCH_DIR, "scenarios");
const CHILD = join(BENCH_DIR, "lib", "child.mjs");
const MAX_WARMUP_RUNS = 1_000_000; // sub-µs ops: 1M runs is far past tier-up

// --- args ---
const argv = process.argv.slice(2);
const opts = {
    samples: null, build: resolve(BENCH_DIR, "..", "build"), filters: [], json: null,
    compare: null, bisect: null, assert: false, reps: null, iters: null,
    warmup: null, minWarmupMs: 100, pad: "auto", aa: true,
};
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compare") { opts.compare = [resolve(argv[++i]), resolve(argv[++i])]; }
    else if (a === "--bisect") {
        opts.bisect = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.bisect.push(resolve(argv[++i]));
        if (opts.bisect.length < 2) { console.error("--bisect needs <base> and at least one build"); process.exit(1); }
    }
    else if (a === "--samples") opts.samples = +argv[++i];
    else if (a === "--build") opts.build = resolve(argv[++i]);
    else if (a === "--filter") opts.filters.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--assert") opts.assert = true;
    else if (a === "--reps") opts.reps = +argv[++i];
    else if (a === "--iters") opts.iters = +argv[++i];
    else if (a === "--warmup") opts.warmup = +argv[++i];
    else if (a === "--min-warmup-ms") opts.minWarmupMs = +argv[++i];
    else if (a === "--pad") opts.pad = "on";
    else if (a === "--no-pad") opts.pad = "off";
    else if (a === "--no-aa") opts.aa = false;
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
}
opts.samples ??= (opts.compare || opts.bisect) ? 20 : 5;

// --- discover scenarios ---
function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith(".mjs")) yield p;
    }
}

function matchesOne(pattern, scenario, variantName) {
    if (pattern === "gate") return scenario.gate === true;
    const full = `${scenario.name}/${variantName}`;
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
    return re.test(full) || re.test(scenario.name);
}
function matchesFilter(scenario, variantName) {
    return opts.filters.length === 0 || opts.filters.some((p) => matchesOne(p, scenario, variantName));
}

const units = [];
for (const file of walk(SCENARIOS_DIR)) {
    const scenario = (await import(pathToFileURL(file).href)).default;
    for (const variant of scenario.variants ?? [{ name: "default" }]) {
        if (matchesFilter(scenario, variant.name)) units.push({ file, scenario, variant: variant.name, variantDef: variant });
    }
}
if (units.length === 0) { console.error("no scenarios match filter"); process.exit(1); }

const unitName = (unit) => `${unit.scenario.name}/${unit.variant}`;
const isLayoutSensitive = (unit) => (unit.variantDef.layoutSensitive ?? unit.scenario.layoutSensitive) === true;
const padEnabled = (unit) => opts.pad === "on" || (opts.pad === "auto" && isLayoutSensitive(unit));
const newSeed = () => (Math.random() * 0xffffffff) >>> 0 || 1;

// --- sample runner ---
// run = { warmup?: number, pad?: seed }
function runSample(unit, buildDir, run = {}, attempt = 0) {
    const args = ["--expose-gc", ...(unit.scenario.nodeFlags ?? []), CHILD, unit.file, unit.variant, buildDir];
    if (opts.reps) args.push(String(opts.reps));
    if (opts.iters) { if (!opts.reps) args.push(String(unit.scenario.reps ?? 7)); args.push(String(opts.iters)); }
    if (run.warmup != null) args.push(`--warmup=${run.warmup}`);
    if (run.pad != null) args.push(`--pad=${run.pad}`);
    const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10 * 60_000 });
    if (res.status !== 0) {
        const detail = `status=${res.status} signal=${res.signal} err=${res.error ?? ""}\n${res.stderr}`;
        // transient spawn hiccups happen on multi-hour runs — retry once
        if (attempt === 0) {
            console.error(`\nchild failed (retrying): ${unitName(unit)} (${buildDir}) ${detail}`);
            return runSample(unit, buildDir, run, 1);
        }
        throw new Error(`child failed twice: ${unitName(unit)} (${buildDir}) ${detail}`);
    }
    const line = res.stdout.trim().split("\n").pop();
    try { return JSON.parse(line); } catch {
        if (attempt === 0) return runSample(unit, buildDir, run, 1);
        throw new Error(`bad child output for ${unitName(unit)}:\n${res.stdout}\n${res.stderr}`);
    }
}

// Warm-up policy. Counts in scenario files were tuned one by one and several
// turned out to cover only a few ms of a µs-scale op (JIT tier-up measured as
// a regression). The harness enforces a minimum warm-up TIME instead: given
// calibration samples (their steady ms/run), return the warm-up count to pass
// to every measured sample, or null to keep the scenario's own count.
function initialWarmup() { return opts.warmup ?? null; }
function calibrateWarmup(unit, calib) {
    if (opts.warmup != null) return opts.warmup;
    const minMs = unit.scenario.minWarmupMs ?? opts.minWarmupMs;
    if (!(minMs > 0) || unit.scenario.measure === "heap") return null;
    if (calib.every((s) => s.warmupMs >= minMs)) return null;
    const opMs = Math.min(...calib.map((s) => s.opMs).filter((v) => v > 0));
    if (!Number.isFinite(opMs)) return null;
    const count = Math.max(calib[0].warmupRuns, Math.ceil(minMs / opMs));
    return Math.min(count, MAX_WARMUP_RUNS);
}

const meta = {
    date: new Date().toISOString(),
    node: process.version,
    gitSha: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: BENCH_DIR, encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
    samples: opts.samples,
    filter: opts.filters.join(",") || null,
    minWarmupMs: opts.minWarmupMs,
    warmup: opts.warmup,
    pad: opts.pad,
};

function writeJson(payload, quiet = false) {
    if (!opts.json) return;
    mkdirSync(dirname(resolve(opts.json)), { recursive: true });
    writeFileSync(resolve(opts.json), JSON.stringify(payload, null, 2));
    if (!quiet) console.log(`\nwrote ${opts.json}`);
}

function progress(msg) { process.stderr.write(msg); }

// One interleaved A/B measurement of one unit. `warmup` undefined = calibrate
// from the discarded warm pair; a number/null = use as is (A/A re-runs reuse
// the flagged run's count so both see the same window).
function compareUnit(unit, dirA, dirB, warmup = undefined) {
    const A = { values: [], gcMs: [], heapKb: [], bytes: new Set() };
    const B = { values: [], gcMs: [], heapKb: [], bytes: new Set() };
    const pad = padEnabled(unit);
    let error = null;
    try {
        // discard one warm pair (fs/process caches) — it doubles as the
        // warm-up calibration; then ABBA ordering so within-pair drift cancels
        // instead of biasing the side that runs second
        const w0 = warmup === undefined ? initialWarmup() : warmup;
        const c1 = runSample(unit, dirA, { warmup: w0, pad: pad ? newSeed() : null });
        const c2 = runSample(unit, dirB, { warmup: w0, pad: pad ? newSeed() : null });
        if (warmup === undefined) warmup = calibrateWarmup(unit, [c1, c2]);
        if (warmup != null && warmup !== c1.warmupRuns) progress(`[warmup ${c1.warmupRuns}→${warmup}] `);
        for (let s = 0; s < opts.samples; s++) {
            const aFirst = s % 2 === 0;
            // the pair shares one layout seed; every pair gets a fresh one
            const run = { warmup, pad: pad ? newSeed() : null };
            const r1 = runSample(unit, aFirst ? dirA : dirB, run);
            const r2 = runSample(unit, aFirst ? dirB : dirA, run);
            const [ra, rb] = aFirst ? [r1, r2] : [r2, r1];
            A.values.push(ra.value); A.gcMs.push(ra.gc.totalMs); A.heapKb.push(ra.heapDeltaKb); A.bytes.add(ra.bytesPerOp);
            B.values.push(rb.value); B.gcMs.push(rb.gc.totalMs); B.heapKb.push(rb.heapDeltaKb); B.bytes.add(rb.bytesPerOp);
            progress(".");
        }
    } catch (e) {
        // don't abort the whole matrix — record what we have and move on
        error = e;
        console.error(`\n${e.message ?? e}`);
    }
    if (A.values.length < 8 || B.values.length < 8) return { ok: false, n: A.values.length, error, warmup };
    const medA = median(A.values), medB = median(B.values);
    const deltaPct = ((medB - medA) / medA) * 100;
    const mwValue = mannWhitneyU(A.values, B.values);
    const mwGc = mannWhitneyU(A.gcMs, B.gcMs);
    const gcA = median(A.gcMs), gcB = median(B.gcMs);
    const sig = mwValue.p < 0.05;
    const gcOnly = !sig && mwGc.p < 0.05 && gcA !== gcB;
    const bytesA = [...A.bytes].join(","), bytesB = [...B.bytes].join(",");
    const twoModes = bimodal(A.values) || bimodal(B.values);
    return { ok: true, n: A.values.length, error, warmup, pad, A, B, medA, medB, deltaPct, p: mwValue.p, pGc: mwGc.p, gcA, gcB, sig, gcOnly, bytesA, bytesB, bimodal: twoModes };
}

function mark(r) {
    const m = r.sig ? (r.deltaPct < 0 ? "✓ faster" : "✗ SLOWER") : r.gcOnly ? "≈ gc-only" : "";
    return r.bimodal ? `${m} (2 modes)`.trim() : m;
}
function fmtAA(aa) { return aa ? (aa.ok ? `${fmtDelta(aa.deltaPct)} (${fmtP(aa.p)})` : "failed") : ""; }
function jsonOf(unit, r) {
    return {
        scenario: unit.scenario.name, variant: unit.variant,
        a: { median: r.medA, values: r.A.values, gcMs: r.A.gcMs, heapKb: r.A.heapKb },
        b: { median: r.medB, values: r.B.values, gcMs: r.B.gcMs, heapKb: r.B.heapKb },
        deltaPct: r.deltaPct, p: r.p, pGc: r.pGc, hlShift: hlShift(r.A.values, r.B.values),
        bytesA: r.bytesA, bytesB: r.bytesB, warmup: r.warmup, layoutPadded: r.pad, bimodal: r.bimodal,
    };
}
const LEGEND_MODES = "(2 modes) = a side's samples split into two regimes (per-process lottery: pretenuring, code/heap placement); its Δ follows the mode mix — add samples, read the A/A.";
const LEGEND_LAYOUT = `(layout) = layout-sensitive row (native-op µs scale): heap layout ${opts.pad === "off" ? "NOT randomised (--no-pad)" : "randomised per sample pair"}; read its Δ against the A/A column.`;

// --- compare mode ---
if (opts.compare) {
    const [dirA, dirB] = opts.compare;
    const aaOn = opts.aa && dirA !== dirB;
    console.log(`compare A=${dirA}  B=${dirB}  samples=${opts.samples}/side (interleaved)  min-warmup=${opts.warmup != null ? `${opts.warmup} runs` : `${opts.minWarmupMs} ms`}\n`);
    const rows = [["scenario/variant", "unit", "A med", "B med", "Δ%", "p", "gcMs A→B", "p(gc)", "heapKb A→B", "bytes", "", ...(aaOn ? ["A/A Δ% (p)"] : [])]];
    const jsonRows = [];
    const failedUnits = [];
    let anyLayout = false;

    for (const unit of units) {
        progress(`${unitName(unit)} `);
        const r = compareUnit(unit, dirA, dirB);
        let aa = null;
        if (r.ok && aaOn && r.sig) { progress(" A/A "); aa = compareUnit(unit, dirA, dirA, r.warmup); }
        progress("\n");

        if (!r.ok) {
            failedUnits.push(`${unitName(unit)} (n=${r.n})`);
            rows.push([unitName(unit), unit.scenario.unit ?? "ms/op", "-", "-", "-", "-", "-", "-", "-", "-", "FAILED", ...(aaOn ? [""] : [])]);
            continue;
        }
        if (r.error) failedUnits.push(`${unitName(unit)} (partial n=${r.n})`);
        const bytesNote = r.bytesA === r.bytesB ? r.bytesA : `A:${r.bytesA}≠B:${r.bytesB} !!`;
        const layout = isLayoutSensitive(unit);
        anyLayout ||= layout;
        rows.push([
            unitName(unit),
            unit.scenario.unit ?? "ms/op",
            fmtNum(r.medA), fmtNum(r.medB), fmtDelta(r.deltaPct), fmtP(r.p),
            `${fmtNum(r.gcA, 3)}→${fmtNum(r.gcB, 3)}`, fmtP(r.pGc),
            `${fmtNum(median(r.A.heapKb), 3)}→${fmtNum(median(r.B.heapKb), 3)}`,
            bytesNote,
            mark(r) + (layout ? " (layout)" : ""),
            ...(aaOn ? [fmtAA(aa)] : []),
        ]);
        jsonRows.push({ ...jsonOf(unit, r), layoutSensitive: layout, aa: aa?.ok ? { deltaPct: aa.deltaPct, p: aa.p, a: aa.A.values, b: aa.B.values } : null });
        // flush after every unit — a killed multi-hour run keeps its finished rows
        writeJson({ meta: { ...meta, mode: "compare", dirA, dirB, partial: `${jsonRows.length}/${units.length}` }, failedUnits, rows: jsonRows }, true);
    }

    console.log("");
    printTable(rows);
    console.log("\n✓/✗ = wall-clock p<0.05; '≈ gc-only' = GC differs at p<0.05 with wall-clock neutral; Δ%<0 means B faster.");
    if (aaOn) console.log("A/A = the flagged unit re-run as A vs A (same warm-up): the noise floor to read its Δ against.");
    if (anyLayout) console.log(LEGEND_LAYOUT);
    if (jsonRows.some((r) => r.bimodal)) console.log(LEGEND_MODES);
    if (failedUnits.length) console.error(`\nFAILED/PARTIAL UNITS:\n  ${failedUnits.join("\n  ")}`);
    writeJson({ meta: { ...meta, mode: "compare", dirA, dirB }, failedUnits, rows: jsonRows });
    process.exit(failedUnits.length ? 1 : 0);
}

// --- bisect mode: base vs each build, one row per unit ---
if (opts.bisect) {
    const [base, ...builds] = opts.bisect;
    const label = (d) => basename(d) === "build" ? basename(dirname(d)) + "/build" : basename(d);
    console.log(`bisect base=${base}  builds=${builds.map(label).join(" ")}  samples=${opts.samples}/side\n`);
    const rows = [["scenario/variant", "unit", "base med", ...builds.map(label), ...(opts.aa ? ["A/A Δ% (p)"] : [])]];
    const jsonRows = [];
    const failedUnits = [];
    let anyLayout = false;
    for (const unit of units) {
        progress(`${unitName(unit)} `);
        const cells = [];
        const per = [];
        let baseMed = null, warmup;
        for (const b of builds) {
            progress(`${label(b)} `);
            const r = compareUnit(unit, base, b, warmup);
            if (!r.ok) { failedUnits.push(`${unitName(unit)} @ ${label(b)} (n=${r.n})`); cells.push("FAILED"); per.push(null); continue; }
            warmup = r.warmup; // calibrate once per unit, reuse for every build
            baseMed ??= r.medA;
            const bytesNote = r.bytesA === r.bytesB ? "" : " bytes≠";
            cells.push(`${fmtDelta(r.deltaPct)} ${r.sig ? (r.deltaPct < 0 ? "✓" : "✗") : ""}${r.bimodal ? " ²" : ""}${bytesNote}`.trim());
            per.push(r);
        }
        let aa = null;
        if (opts.aa && per.some((r) => r?.sig)) { progress("A/A "); aa = compareUnit(unit, base, base, warmup ?? null); }
        progress("\n");
        const layout = isLayoutSensitive(unit);
        anyLayout ||= layout;
        rows.push([unitName(unit) + (layout ? " (layout)" : ""), unit.scenario.unit ?? "ms/op", fmtNum(baseMed), ...cells, ...(opts.aa ? [fmtAA(aa)] : [])]);
        jsonRows.push({
            scenario: unit.scenario.name, variant: unit.variant, layoutSensitive: layout,
            builds: builds.map((b, k) => ({ build: b, ...(per[k] ? jsonOf(unit, per[k]) : { failed: true }) })),
            aa: aa?.ok ? { deltaPct: aa.deltaPct, p: aa.p } : null,
        });
        writeJson({ meta: { ...meta, mode: "bisect", base, builds, partial: `${jsonRows.length}/${units.length}` }, failedUnits, rows: jsonRows }, true);
    }
    console.log("");
    printTable(rows);
    console.log("\nEach cell = Δ% of that build vs base (✓/✗ = p<0.05, ² = two-mode samples, see below); the first ✗ column localises a regression.");
    if (jsonRows.some((r) => r.builds.some((b) => b.bimodal))) console.log(LEGEND_MODES);
    if (anyLayout) console.log(LEGEND_LAYOUT);
    if (failedUnits.length) console.error(`\nFAILED/PARTIAL UNITS:\n  ${failedUnits.join("\n  ")}`);
    writeJson({ meta: { ...meta, mode: "bisect", base, builds }, failedUnits, rows: jsonRows });
    process.exit(failedUnits.length ? 1 : 0);
}

// --- single mode (with optional --assert budget gate) ---
console.log(`build=${opts.build}  samples=${opts.samples}\n`);
const rows = [["scenario/variant", "unit", "median", "IQR", "gcMs", "gc#", "heapKb", "bytes/op"]];
const jsonRows = [];
const failures = [];

for (const unit of units) {
    const samples = [];
    const pad = padEnabled(unit);
    progress(`${unitName(unit)} `);
    // the first sample calibrates the warm-up; it is kept unless the
    // warm-up had to be raised (then it measured a short window)
    const first = runSample(unit, opts.build, { warmup: initialWarmup(), pad: pad ? newSeed() : null });
    const warmup = calibrateWarmup(unit, [first]);
    if (warmup == null || warmup === first.warmupRuns) { samples.push(first); progress("."); }
    else progress(`[warmup ${first.warmupRuns}→${warmup}] `);
    while (samples.length < opts.samples) { samples.push(runSample(unit, opts.build, { warmup, pad: pad ? newSeed() : null })); progress("."); }
    progress("\n");

    const values = samples.map((s) => s.value);
    const med = median(values);
    rows.push([
        unitName(unit) + (isLayoutSensitive(unit) ? " (layout)" : ""),
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
        bytesPerOp: samples[0].bytesPerOp, warmup: samples[0].warmupRuns, warmupMs: samples.map((s) => s.warmupMs),
        layoutPadded: pad,
    });

    const budget = unit.scenario.budget?.[unit.variant];
    if (opts.assert && budget !== undefined && med > budget) {
        failures.push(`${unitName(unit)}: median ${fmtNum(med)} > budget ${budget}`);
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
