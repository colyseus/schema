// Group a `--trace-turbo-inlining` log by optimized function: what TurboFan
// inlined into it, what it looked at and refused, and why.
// Usage: node bench/lib/analyze-inlining.mjs <file.inlining.log> [--fn name] [--top 20]
//
// Lines (V8 11.x; run with --no-concurrent-recompilation so they don't interleave):
//   [compiling method 0x.. <JSFunction name (sfi = X)> (target TURBOFAN)[ OSR], mode: ...]
//   Considering <addr> {0x.. <SharedFunctionInfo name>} for inlining with <addr> {0x.. <FeedbackVector[n]>}
//   Inlining small function(s) at call site #N:JSCall
//   Inlining <addr> {0x.. <SharedFunctionInfo callee>} into <addr> {0x.. <SharedFunctionInfo target>}
//   Not inlining <addr> {0x.. <SharedFunctionInfo callee>} into <addr> {0x.. <SharedFunctionInfo target>} because ...
//   ... plus free-form budget / size lines ("exceeds", "budget", "too big", "polymorphic")
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SFI = String.raw`\{0x[0-9a-f]+ <SharedFunctionInfo ?(.*?)>\}`;
const RE = {
    compile: /^\[compiling method 0x[0-9a-f]+ <JSFunction ?(.*?) \(sfi = [0-9A-Fa-f]+\)> \(target (\w+)\)( OSR)?/,
    considering: new RegExp(String.raw`^Considering [0-9A-Fa-f]+ ${SFI} for inlining`),
    inlined: new RegExp(String.raw`^Inlining [0-9A-Fa-f]+ ${SFI} into [0-9A-Fa-f]+ ${SFI}`),
    notInlined: new RegExp(String.raw`^Not inlining [0-9A-Fa-f]+ ${SFI} into [0-9A-Fa-f]+ ${SFI}(.*)$`),
    small: /^Inlining small function\(s\) at call site #(\d+):(\w+)/,
};

export function parseInliningLog(text) {
    const targets = new Map();
    const get = (name) => {
        const key = name || "(anonymous)";
        let t = targets.get(key);
        if (!t) { t = { name: key, compiles: 0, osr: 0, inlined: new Map(), refused: new Map(), considered: new Set(), notes: [] }; targets.set(key, t); }
        return t;
    };
    let current = null;
    for (const line of text.split(/\r?\n/)) {
        let m;
        if ((m = RE.compile.exec(line))) {
            current = get(m[1]);
            current.compiles++;
            if (m[3]) current.osr++;
        } else if ((m = RE.inlined.exec(line))) {
            const t = get(m[2]);
            t.inlined.set(m[1] || "(anonymous)", (t.inlined.get(m[1] || "(anonymous)") ?? 0) + 1);
        } else if ((m = RE.notInlined.exec(line))) {
            const t = get(m[2]);
            const reason = m[3].trim().replace(/^because\s*/, "");
            const k = `${m[1] || "(anonymous)"} — ${reason}`;
            t.refused.set(k, (t.refused.get(k) ?? 0) + 1);
        } else if ((m = RE.considering.exec(line))) {
            if (current) current.considered.add(m[1] || "(anonymous)");
        } else if (current && /budget|too big|exceed|polymorphic|megamorphic|not inlin|bailout/i.test(line) && !RE.small.test(line)) {
            if (current.notes.length < 20) current.notes.push(line.trim());
        }
    }
    return [...targets.values()];
}

export function printInliningReport(targets, { fn = null, top = 20 } = {}) {
    let list = targets.filter((t) => t.compiles > 0 || t.inlined.size > 0);
    if (fn) list = list.filter((t) => t.name === fn || t.name.includes(fn));
    list.sort((a, b) => (b.inlined.size + b.refused.size) - (a.inlined.size + a.refused.size));
    if (list.length === 0) { console.log(fn ? `no optimized function matches "${fn}"` : "no inlining decisions recorded"); return; }
    for (const t of list.slice(0, top)) {
        console.log(`\n== ${t.name}  (compiled ${t.compiles}×${t.osr ? `, ${t.osr} OSR` : ""})`);
        if (t.inlined.size) console.log("  inlined:  " + [...t.inlined.entries()].map(([n, c]) => c > 1 ? `${n}×${c}` : n).join(", "));
        if (t.refused.size) { console.log("  refused:"); for (const [k, c] of t.refused) console.log(`    ${k}${c > 1 ? ` (×${c})` : ""}`); }
        const notConsidered = [...t.considered].filter((n) => !t.inlined.has(n));
        if (notConsidered.length) console.log("  considered, not inlined: " + notConsidered.join(", "));
        for (const n of t.notes) console.log("  note: " + n);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) { console.error("usage: analyze-inlining.mjs <file.inlining.log> [--fn name] [--top N]"); process.exit(1); }
    const fn = args.includes("--fn") ? args[args.indexOf("--fn") + 1] : null;
    const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 20;
    printInliningReport(parseInliningLog(readFileSync(file, "utf8")), { fn, top });
}
