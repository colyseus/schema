// One benchmark sample in an isolated process.
//
//   node --expose-gc bench/lib/child.mjs <scenarioFile> <variantName> <buildDir> [reps] [iters]
//        [--warmup=N] [--pad=SEED]
//
// --warmup=N  overrides the scenario's warm-up run count (run.mjs passes a
//             count calibrated to a minimum warm-up TIME, see run.mjs).
// --pad=SEED  allocates a seeded-random amount of retained padding (and some
//             garbage) before setup(), so the fixture lands at a different
//             heap position every sample (layout-sensitive rows).
//
// Prints exactly one JSON line to stdout. Everything else goes to stderr.
//
// Scenario contract (default export):
//   {
//     name, unit,                    // e.g. "encoder/steady-tick", "ms/tick"
//     variants: [{ name, ... }],     // variant fields are free-form, read by setup()
//     iterations, reps, warmup?,     // variant.iterations overrides scenario.iterations
//     valueScale?,                   // value = median(msPerRun) * valueScale (default 1)
//     measure?: "time" | "heap",     // "heap": value = heapDeltaKb across the timed runs
//     budget?: { [variantName]: n }, // optional gate budget in `unit`
//     gate?: true,                   // include in `--filter gate` release checks
//     layoutSensitive?: true,        // (or per variant) run.mjs randomises heap layout per sample (--pad)
//     minWarmupMs?: n,               // per-scenario minimum warm-up time (run.mjs; 0 = counts only)
//     nodeFlags?: ["--flag"],       // extra V8/node flags for the child process
//     async setup(lib, variant, plan) -> ctx
//     run(ctx, i) -> bytes | undefined   // ONE op; i = global run index
//     teardown?(ctx)
//   }
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createGcTracker, getGcHandle, heapUsed, flushGcEntries } from "./gc.mjs";
import { median } from "./stats.mjs";

const positional = [];
const named = {};
for (const a of process.argv.slice(2)) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (m) named[m[1]] = m[2];
    else positional.push(a);
}
const [scenarioFile, variantName, buildDir, repsArg, itersArg] = positional;
if (!scenarioFile || !variantName || !buildDir) {
    console.error("usage: child.mjs <scenarioFile> <variantName> <buildDir> [reps] [iters]");
    process.exit(1);
}

const gc = getGcHandle();
if (!gc) {
    console.error("no gc handle available — run with --expose-gc");
    process.exit(1);
}

const scenario = (await import(pathToFileURL(resolve(scenarioFile)).href)).default;
const lib = await import(pathToFileURL(resolve(buildDir, "index.mjs")).href);

const variants = scenario.variants ?? [{ name: "default" }];
const variant = variants.find((v) => v.name === variantName);
if (!variant) {
    console.error(`unknown variant "${variantName}" for ${scenario.name} (have: ${variants.map((v) => v.name).join(", ")})`);
    process.exit(1);
}

const profileMode = process.env.BENCH_PROFILE === "1";
const iterations = itersArg ? +itersArg
    : (variant.iterations ?? scenario.iterations ?? 1000) * (profileMode ? 10 : 1);
const reps = repsArg ? +repsArg : (scenario.reps ?? 7);
const warmup = named.warmup !== undefined ? +named.warmup
    : scenario.warmup ?? Math.min(iterations, Math.max(50, Math.floor(iterations / 5)));
const plan = { warmup, reps, iterations, totalRuns: warmup + reps * iterations };

// Heap-layout randomisation: a seeded amount of retained padding (arrays and
// strings of random sizes, interleaved with garbage) shifts where setup()
// places the fixture — and so the cache-set / page placement of hash tables
// and key strings — without touching the measured code.
let padKb = 0;
globalThis.__benchPad = named.pad !== undefined ? padHeap(+named.pad) : null;
function padHeap(seed) {
    let s = (seed >>> 0) || 1;
    const rnd = () => { // mulberry32
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const keep = [];
    let garbage = null;
    const chunks = 1 + Math.floor(rnd() * 256);
    let bytes = 0;
    for (let i = 0; i < chunks; i++) {
        const len = Math.floor(rnd() * 1024);
        const a = [];
        for (let j = 0; j < len; j++) a.push(j);
        const str = "pad" + i + ":" + "x".repeat(Math.floor(rnd() * 256));
        if (rnd() < 0.5) { keep.push(a, str); bytes += len * 8 + str.length; }
        else garbage = [a, str, garbage]; // chain dropped at the end
    }
    garbage = null;
    padKb = +(bytes / 1024).toFixed(1);
    return keep;
}

const ctx = await scenario.setup(lib, variant, plan);

let runIndex = 0;
let sink = 0;
const tw0 = process.hrtime.bigint();
for (let i = 0; i < warmup; i++) sink ^= scenario.run(ctx, runIndex++) | 0;
const warmupMs = Number(process.hrtime.bigint() - tw0) / 1e6;

const tracker = createGcTracker();
const heapBefore = profileMode ? 0 : heapUsed(gc);
await flushGcEntries(); // let the forced-gc entries land before zeroing
tracker.reset();

const repMs = [];
let bytesTotal = 0;
let bytesOps = 0;
for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const ret = scenario.run(ctx, runIndex++);
        if (typeof ret === "number") { bytesTotal += ret; bytesOps++; }
        sink ^= ret | 0;
    }
    const t1 = process.hrtime.bigint();
    repMs.push(Number(t1 - t0) / 1e6 / iterations);
}

await flushGcEntries();
const gcStats = tracker.snapshot();
const heapAfter = profileMode ? 0 : heapUsed(gc);
tracker.disconnect();
scenario.teardown?.(ctx);
if (sink === 123456789) console.error(""); // DCE guard

const totalOps = reps * iterations;
const value = scenario.measure === "heap"
    ? (heapAfter - heapBefore) / 1024
    : median(repMs) * (scenario.valueScale ?? 1);

process.stdout.write(JSON.stringify({
    scenario: scenario.name,
    variant: variant.name,
    unit: scenario.measure === "heap" ? "KB" : (scenario.unit ?? "ms/op"),
    value: +value.toPrecision(6),
    reps: repMs.map((v) => +v.toPrecision(6)),
    gc: gcStats,
    gcMsPerKOp: +((gcStats.totalMs / totalOps) * 1000).toPrecision(4),
    heapDeltaKb: profileMode ? null : +((heapAfter - heapBefore) / 1024).toFixed(1),
    bytesPerOp: bytesOps ? Math.round(bytesTotal / bytesOps) : null,
    iterations,
    repsCount: reps,
    opMs: +median(repMs).toPrecision(6), // raw ms per run (unscaled)
    warmupRuns: warmup,
    warmupMs: +warmupMs.toFixed(2),
    pad: named.pad !== undefined ? +named.pad : null,
    padKb,
    node: process.version,
    buildDir,
}) + "\n");
