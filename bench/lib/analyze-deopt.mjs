// Summarize a `--trace-deopt-verbose --trace-opt` log per function.
// Usage: node bench/lib/analyze-deopt.mjs <file.deopt.log> [--top 30] [--all]
//
// Parsed lines (V8 11.x / Node 20):
//   [marking 0x.. <JSFunction name (sfi = X)> for optimization to TURBOFAN, ..., reason: R]
//   [compiling method 0x.. <JSFunction name (sfi = X)> (target TURBOFAN)[ OSR], mode: ...]
//   [completed compiling 0x.. <JSFunction name (sfi = X)> (target TURBOFAN)[ OSR] - took a, b, c ms]
//   [bailout (kind: deopt-eager|deopt-lazy|deopt-soft, reason: R): begin. deoptimizing 0x.. <JSFunction name (sfi = X)>, ...]
//               ;;; deoptimize at <file:///.../index.mjs:LINE:COL>          (verbose only)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FN = String.raw`<JSFunction ?(.*?) \(sfi = ([0-9A-Fa-f]+)\)>`;
const RE = {
    mark: new RegExp(String.raw`^\[marking 0x[0-9a-f]+ ${FN} for optimization to (\w+),.*reason: (.*)\]$`),
    compile: new RegExp(String.raw`^\[compiling method 0x[0-9a-f]+ ${FN} \(target (\w+)\)( OSR)?`),
    completed: new RegExp(String.raw`^\[completed compiling 0x[0-9a-f]+ ${FN} \(target (\w+)\)( OSR)? - took ([\d.]+), ([\d.]+), ([\d.]+) ms`),
    bailout: new RegExp(String.raw`^\[bailout \(kind: ([^,]+), reason: (.*?)\): begin\. deoptimizing 0x[0-9a-f]+ ${FN}`),
    at: /^\s*;;; deoptimize at <(.*):(\d+):(\d+)>/,
};

function shortFile(url) {
    return url.replace(/^file:\/\/\/?/, "").replace(/^.*\/(src|build|bench)\//, "$1/");
}

export function parseDeoptLog(text) {
    const fns = new Map();
    const get = (name, sfi) => {
        const key = `${name}|${sfi}`;
        let f = fns.get(key);
        if (!f) { f = { name: name || "(anonymous)", sfi, marks: 0, compiles: 0, osr: 0, completedMs: 0, deopts: [], reasons: new Map(), kinds: new Map(), where: null }; fns.set(key, f); }
        return f;
    };
    let pending = null;
    for (const line of text.split(/\r?\n/)) {
        let m;
        if ((m = RE.bailout.exec(line))) {
            const f = get(m[3], m[4]);
            const d = { kind: m[1], reason: m[2], at: null };
            f.deopts.push(d);
            f.reasons.set(m[2], (f.reasons.get(m[2]) ?? 0) + 1);
            f.kinds.set(m[1], (f.kinds.get(m[1]) ?? 0) + 1);
            pending = d;
        } else if (pending && (m = RE.at.exec(line))) {
            pending.at = { file: m[1], line: +m[2], col: +m[3] };
            const f = get(pending.__fnName ?? "", pending.__sfi ?? "");
            pending = null;
            void f;
        } else if ((m = RE.mark.exec(line))) {
            get(m[1], m[2]).marks++;
        } else if ((m = RE.compile.exec(line))) {
            const f = get(m[1], m[2]);
            f.compiles++;
            if (m[4]) f.osr++;
        } else if ((m = RE.completed.exec(line))) {
            get(m[1], m[2]).completedMs += +m[6];
        }
    }
    // location = the most frequent deopt site
    for (const f of fns.values()) {
        const sites = new Map();
        for (const d of f.deopts) if (d.at) { const k = `${shortFile(d.at.file)}:${d.at.line}:${d.at.col}`; sites.set(k, (sites.get(k) ?? 0) + 1); }
        f.sites = [...sites.entries()].sort((a, b) => b[1] - a[1]);
        f.where = f.sites[0]?.[0] ?? null;
        f.inLib = f.deopts.some((d) => d.at && /index\.mjs$/.test(d.at.file));
    }
    return [...fns.values()];
}

export function printDeoptReport(fns, { top = 30, all = false } = {}) {
    const totalDeopts = fns.reduce((s, f) => s + f.deopts.length, 0);
    const totalCompiles = fns.reduce((s, f) => s + f.compiles, 0);
    const withDeopts = fns.filter((f) => f.deopts.length > 0 && (all || f.inLib))
        .sort((a, b) => b.deopts.length - a.deopts.length || b.compiles - a.compiles);
    console.log(`deopts: ${totalDeopts} total (${withDeopts.reduce((s, f) => s + f.deopts.length, 0)} shown${all ? "" : ", library bundle only; --all for everything"}); optimizations: ${totalCompiles} compiles across ${fns.length} functions\n`);
    const rows = withDeopts.slice(0, top).map((f) => ({
        function: f.name,
        "deopt site": f.where ?? "?",
        deopts: f.deopts.length,
        kinds: [...f.kinds.entries()].map(([k, n]) => `${k.replace("deopt-", "")}×${n}`).join(" "),
        "top reasons": [...f.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join("; "),
        opts: f.compiles + (f.osr ? ` (${f.osr} osr)` : ""),
        flag: (f.deopts.length >= 2 && f.compiles >= 3) ? "LOOP" : (f.deopts.length >= 2 ? "repeat" : ""),
    }));
    printRows(rows);

    const churn = fns.filter((f) => f.compiles >= 4 && (all || f.deopts.length === 0))
        .sort((a, b) => b.compiles - a.compiles).slice(0, 10);
    if (churn.length) {
        console.log("\nmost recompiled without a recorded deopt (name|sfi — the same name can be several closures):");
        printRows(churn.map((f) => ({ function: f.name, sfi: f.sfi, compiles: f.compiles, osr: f.osr, "compile ms": f.completedMs.toFixed(1) })));
    }
}

function printRows(rows) {
    if (rows.length === 0) { console.log("(none)"); return; }
    const cols = Object.keys(rows[0]);
    const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
    const line = (vals) => vals.map((v, i) => String(v).padEnd(width[i])).join("  ");
    console.log(line(cols));
    console.log(line(width.map((w) => "-".repeat(w))));
    for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) { console.error("usage: analyze-deopt.mjs <file.deopt.log> [--top N] [--all]"); process.exit(1); }
    const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 30;
    printDeoptReport(parseDeoptLog(readFileSync(file, "utf8")), { top, all: args.includes("--all") });
}
