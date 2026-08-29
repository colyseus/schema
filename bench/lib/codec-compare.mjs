#!/usr/bin/env node
// Pair the v5 and v6 rows of a single-mode `--json` run and report Δ bytes,
// Δ median time and a Mann-Whitney p-value per scenario/variant.
//
//   node bench/run.mjs --samples 20 --json bench/results/codecs.json
//   node bench/lib/codec-compare.mjs bench/results/codecs.json
import { readFileSync } from "node:fs";
import { mannWhitneyU } from "./stats.mjs";
import { printTable, fmtNum, fmtDelta, fmtP } from "./report.mjs";

const files = process.argv.slice(2);
if (files.length === 0) { console.error("usage: codec-compare.mjs <run.json> [more.json...]"); process.exit(1); }
const rows = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).rows);

const byKey = new Map(rows.map((r) => [`${r.scenario}/${r.variant}`, r]));
const table = [["scenario/variant", "unit", "v5 med", "v6 med", "Δ time", "p", "v5 bytes", "v6 bytes", "Δ bytes"]];
for (const r of rows) {
    if (r.variant.endsWith("-v6")) continue;
    const v6 = byKey.get(`${r.scenario}/${r.variant}-v6`);
    if (!v6) continue;
    const dt = ((v6.median - r.median) / r.median) * 100;
    const p = mannWhitneyU(r.values, v6.values).p;
    const db = (r.bytesPerOp && v6.bytesPerOp) ? ((v6.bytesPerOp - r.bytesPerOp) / r.bytesPerOp) * 100 : null;
    table.push([
        `${r.scenario}/${r.variant}`, r.unit,
        fmtNum(r.median), fmtNum(v6.median), fmtDelta(dt), fmtP(p),
        r.bytesPerOp ?? "-", v6.bytesPerOp ?? "-", db === null ? "-" : fmtDelta(db),
    ]);
}
printTable(table);
console.log("\nΔ<0 means v6 smaller/faster. Time rows are significant at p<0.05 with N≥20 samples.");
