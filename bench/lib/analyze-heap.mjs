// Rank a V8 .heapprofile (sampling allocation profile from --heap-prof) by
// allocation site: sampled self-bytes + inclusive subtree bytes per function.
// Usage: node bench/lib/analyze-heap.mjs <file.heapprofile> [--top 25] [--filter substr] [--json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { frameKey } from "./analyze-cpu.mjs";

export function analyzeHeapProfile(profile, { excludeSetup = true } = {}) {
    const byFn = new Map();
    let total = 0;
    let setupBytes = 0;

    const isSetupFrame = (f) => f.functionName === "setup" && (f.url || "").includes("/scenarios/");

    // walk the {callFrame, selfSize, children} tree
    function inclusive(node, inSetup) {
        if (excludeSetup && !inSetup && isSetupFrame(node.callFrame)) inSetup = true;
        let sum = 0;
        for (const c of node.children ?? []) sum += inclusive(c, inSetup);
        if (inSetup) {
            setupBytes += node.selfSize || 0;
            return 0; // excluded from rankings and parent subtree sums
        }
        sum += node.selfSize || 0;
        const k = frameKey(node.callFrame);
        if (k && typeof k === "string") {
            const row = byFn.get(k) ?? { name: k, self: 0, inclusive: 0 };
            row.self += node.selfSize || 0;
            row.inclusive += sum;
            byFn.set(k, row);
        }
        total += node.selfSize || 0;
        return sum;
    }
    inclusive(profile.head, false);
    return { total, setupBytes, rows: [...byFn.values()] };
}

export function printHeapReport({ total, setupBytes = 0, rows }, { top = 25, filter = null } = {}) {
    const match = (r) => !filter || r.name.includes(filter);
    const pct = (b) => ((b / total) * 100).toFixed(1).padStart(5);
    const kb = (b) => (b / 1024).toFixed(0).padStart(9);

    console.log(`Total sampled allocations: ${(total / 1024 / 1024).toFixed(1)} MB (setup excluded: ${(setupBytes / 1024 / 1024).toFixed(1)} MB)\n`);
    console.log(`=== TOP ${top} ALLOCATION SITES (sampled self bytes) ===`);
    for (const r of rows.filter(match).sort((a, b) => b.self - a.self).slice(0, top)) {
        if (r.self === 0) break;
        console.log(`${kb(r.self)}KB  ${pct(r.self)}%  ${r.name}`);
    }
    console.log(`\n=== TOP ${Math.ceil(top / 2)} by INCLUSIVE (subtree) bytes ===`);
    for (const r of rows.filter(match).sort((a, b) => b.inclusive - a.inclusive).slice(0, Math.ceil(top / 2))) {
        console.log(`${kb(r.inclusive)}KB  ${pct(r.inclusive)}%  ${r.name}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 25;
    const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;
    const result = analyzeHeapProfile(JSON.parse(readFileSync(file, "utf8")), { excludeSetup: !args.includes("--include-setup") });
    if (args.includes("--json")) {
        console.log(JSON.stringify({ totalBytes: result.total, rows: result.rows.sort((a, b) => b.self - a.self) }, null, 2));
    } else {
        printHeapReport(result, { top, filter });
    }
}
