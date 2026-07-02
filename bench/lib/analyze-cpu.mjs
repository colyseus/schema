// Rank a V8 .cpuprofile by self/total time, aggregated per function.
// Usage: node bench/lib/analyze-cpu.mjs <file.cpuprofile> [--top 25] [--filter substr] [--json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function frameKey(callFrame) {
    const url = callFrame.url || "";
    const fn = callFrame.functionName || "(anonymous)";
    if (url.includes("node:") || url.startsWith("internal/")) return null;
    if (url.includes("/node_modules/tsx/") || url.includes("/node_modules/esbuild")) return null;
    if (url === "") {
        // V8 meta frames: (garbage collector), (program), (idle), (root)
        return fn.startsWith("(") ? { meta: fn } : null;
    }
    const file = url.replace(/^file:\/\//, "").replace(/^.*\/(src|build|bench)\//, "$1/");
    return `${fn} (${file}:${callFrame.lineNumber + 1})`;
}

/** Node ids whose stack passes through a scenario `setup()` frame (or fixture builders called from it). */
export function collectSetupSubtree(profile) {
    const isSetupRoot = (n) => {
        const f = n.callFrame;
        return f.functionName === "setup" && (f.url || "").includes("/scenarios/");
    };
    const excluded = new Set();
    const stack = profile.nodes.filter(isSetupRoot).map((n) => n.id);
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    while (stack.length) {
        const id = stack.pop();
        if (excluded.has(id)) continue;
        excluded.add(id);
        const n = byId.get(id);
        if (n?.children) stack.push(...n.children);
    }
    return excluded;
}

export function analyzeCpuProfile(profile, { excludeSetup = true } = {}) {
    const nodes = new Map();
    for (const n of profile.nodes) nodes.set(n.id, { ...n, selfTime: 0, totalTime: 0 });
    const excluded = excludeSetup ? collectSetupSubtree(profile) : new Set();

    let total = 0;
    let setupTime = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = profile.timeDeltas[i] ?? 0;
        const id = profile.samples[i];
        if (excluded.has(id)) { setupTime += dt; continue; }
        const node = nodes.get(id);
        if (node) node.selfTime += dt;
        total += dt;
    }

    // totalTime via post-order
    const parent = new Map();
    for (const n of profile.nodes) if (n.children) for (const c of n.children) parent.set(c, n.id);
    const order = [];
    const visited = new Set();
    const stack = [];
    for (const n of profile.nodes) {
        if (parent.has(n.id)) continue;
        stack.push([n.id, false]);
        while (stack.length) {
            const [id, expanded] = stack.pop();
            if (expanded) { order.push(id); continue; }
            if (visited.has(id)) continue;
            visited.add(id);
            stack.push([id, true]);
            const node = nodes.get(id);
            if (node?.children) for (const c of node.children) stack.push([c, false]);
        }
    }
    for (const id of order) {
        const n = nodes.get(id);
        n.totalTime = n.selfTime;
        if (n.children) for (const c of n.children) n.totalTime += nodes.get(c).totalTime;
    }

    // aggregate per function (same fn appears under many call paths)
    const byFn = new Map();
    const meta = { "(garbage collector)": 0, "(program)": 0, "(idle)": 0 };
    for (const n of nodes.values()) {
        const k = frameKey(n.callFrame);
        if (k === null) continue;
        if (typeof k === "object") {
            if (k.meta in meta) meta[k.meta] += n.selfTime;
            continue;
        }
        const row = byFn.get(k) ?? { name: k, self: 0, total: 0 };
        row.self += n.selfTime;
        row.total += n.totalTime; // note: recursive fns may double-count total
        byFn.set(k, row);
    }
    return { total, setupTime, rows: [...byFn.values()], meta };
}

export function printCpuReport({ total, setupTime = 0, rows, meta }, { top = 25, filter = null } = {}) {
    const match = (r) => !filter || r.name.includes(filter);
    const pct = (us) => ((us / total) * 100).toFixed(1).padStart(5);
    const ms = (us) => (us / 1000).toFixed(1).padStart(8);

    console.log(`Total sampled: ${(total / 1000).toFixed(1)}ms (setup excluded: ${(setupTime / 1000).toFixed(1)}ms) | GC ${pct(meta["(garbage collector)"])}% | program ${pct(meta["(program)"])}%\n`);
    console.log(`=== TOP ${top} by SELF TIME ===`);
    for (const r of rows.filter(match).sort((a, b) => b.self - a.self).slice(0, top)) {
        console.log(`${ms(r.self)}ms  ${pct(r.self)}%  ${r.name}`);
    }
    console.log(`\n=== TOP ${Math.ceil(top / 2)} by TOTAL TIME (incl. callees) ===`);
    for (const r of rows.filter(match).sort((a, b) => b.total - a.total).slice(0, Math.ceil(top / 2))) {
        console.log(`${ms(r.total)}ms  ${pct(r.total)}%  ${r.name}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 25;
    const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;
    const result = analyzeCpuProfile(JSON.parse(readFileSync(file, "utf8")), { excludeSetup: !args.includes("--include-setup") });
    if (args.includes("--json")) {
        console.log(JSON.stringify({ totalUs: result.total, meta: result.meta, rows: result.rows.sort((a, b) => b.self - a.self) }, null, 2));
    } else {
        printCpuReport(result, { top, filter });
    }
}
