// One benchmark sample in an isolated process.
//
//   node --expose-gc bench/lib/child.mjs <scenarioFile> <variantName> <buildDir> [reps] [iters]
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
//     async setup(lib, variant, plan) -> ctx
//     run(ctx, i) -> bytes | undefined   // ONE op; i = global run index
//     teardown?(ctx)
//   }
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createGcTracker, getGcHandle, heapUsed, flushGcEntries } from "./gc.mjs";
import { median } from "./stats.mjs";

const [, , scenarioFile, variantName, buildDir, repsArg, itersArg] = process.argv;
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
const warmup = scenario.warmup ?? Math.min(iterations, Math.max(50, Math.floor(iterations / 5)));
const plan = { warmup, reps, iterations, totalRuns: warmup + reps * iterations };

const ctx = await scenario.setup(lib, variant, plan);

let runIndex = 0;
let sink = 0;
for (let i = 0; i < warmup; i++) sink ^= scenario.run(ctx, runIndex++) | 0;

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
    node: process.version,
    buildDir,
}) + "\n");
