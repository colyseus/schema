// Inline-cache state report from a `--log-ic --log-code` v8.log (Node does not
// ship V8's tools/ic-processor, so the rows are parsed here).
// Usage: node bench/lib/analyze-ic.mjs <file.v8.log> [--top 40] [--all] [--state N|P|G]
//
// Rows (V8 11.x):
//   code-creation,<type>,<kind>,<timestamp>,<start>,<size>,<name>[,<sfi>,<state>]
//       name = "<fn> <url>:<line>:<col>" — fn may be empty
//   code-move,<from>,<to>          code-delete,<addr>
//   LoadIC|KeyedLoadIC|StoreIC|KeyedStoreIC|LoadGlobalIC|StoreGlobalIC|StoreInArrayLiteralIC,
//       <pc>,<time>,<line>,<column>,<old>,<new>,<map>,<key>,<modifier>,<slow_reason>
//   IC states: 0 uninitialized, . premonomorphic, 1 monomorphic, ^ recompute handler,
//              P polymorphic, N megamorphic, G generic, X no feedback
//
// Caveats printed with the report: optimized code with inlined monomorphic
// handlers never logs; once a site reaches N it stays quiet in the stub cache;
// call-site polymorphism is not an IC event (see --inlining for calls).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const IC_TYPES = new Set(["LoadIC", "KeyedLoadIC", "StoreIC", "KeyedStoreIC", "LoadGlobalIC", "StoreGlobalIC", "StoreInArrayLiteralIC", "DefineNamedOwnIC", "DefineKeyedOwnIC"]);
const STATE_NAME = { "0": "uninit", ".": "premono", "1": "mono", "^": "recompute", "P": "poly", "N": "MEGA", "G": "generic", "X": "nofeedback" };
const STATE_RANK = { N: 3, G: 2, P: 1 };

function shortFile(url) {
    return url.replace(/^file:\/\/\/?/, "").replace(/^.*\/(src|build|bench)\//, "$1/");
}

class CodeMap {
    constructor() { this.starts = []; this.entries = []; }
    _idx(start) { let lo = 0, hi = this.starts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (this.starts[mid] < start) lo = mid + 1; else hi = mid; } return lo; }
    add(start, size, name) {
        const i = this._idx(start);
        if (this.starts[i] === start) { this.entries[i] = { start, end: start + size, name }; return; }
        this.starts.splice(i, 0, start);
        this.entries.splice(i, 0, { start, end: start + size, name });
    }
    move(from, to) {
        const i = this._idx(from);
        if (this.starts[i] !== from) return;
        const e = this.entries[i];
        this.starts.splice(i, 1); this.entries.splice(i, 1);
        this.add(to, e.end - e.start, e.name);
    }
    del(addr) {
        const i = this._idx(addr);
        if (this.starts[i] === addr) { this.starts.splice(i, 1); this.entries.splice(i, 1); }
    }
    find(pc) {
        let i = this._idx(pc);
        if (this.starts[i] !== pc) i--;
        const e = this.entries[i];
        return (e && pc < e.end) ? e : null;
    }
}

function splitName(name) {
    // "fn file:///C:/x/index.mjs:12:34" or " file:///...:1:1" (anonymous)
    const m = /^(.*?) ?((?:file|node|https?):[^ ]*):(\d+):(\d+)$/.exec(name.trim());
    if (!m) return { fn: name.trim() || "(anonymous)", file: "", line: 0, col: 0 };
    return { fn: m[1].trim() || "(anonymous)", file: m[2], line: +m[3], col: +m[4] };
}

export function parseIcLog(text) {
    const code = new CodeMap();
    const sites = new Map();
    let icRows = 0, unattributed = 0;
    for (const line of text.split(/\r?\n/)) {
        const c = line.indexOf(",");
        if (c < 0) continue;
        const type = line.slice(0, c);
        if (type === "code-creation") {
            const f = line.split(",");
            const start = parseInt(f[4], 16), size = +f[5];
            // name may itself contain commas only in pathological cases; sfi/state are the last two fields when present
            const nameField = (f.length > 9) ? f.slice(6, f.length - 2).join(",") : f[6];
            code.add(start, size, nameField ?? "");
        } else if (type === "code-move") {
            const f = line.split(",");
            code.move(parseInt(f[1], 16), parseInt(f[2], 16));
        } else if (type === "code-delete") {
            code.del(parseInt(line.split(",")[1], 16));
        } else if (IC_TYPES.has(type)) {
            const f = line.split(",");
            icRows++;
            const pc = parseInt(f[1], 16);
            const entry = code.find(pc);
            const where = entry ? splitName(entry.name) : null;
            if (!where) unattributed++;
            const lineNo = +f[3], col = +f[4], oldS = f[5], newS = f[6], map = f[7], key = f[8], slow = f[10] ?? "";
            const file = where?.file ?? "?";
            const k = `${type}|${file}|${lineNo}|${col}|${key}`;
            let s = sites.get(k);
            if (!s) { s = { type, fn: where?.fn ?? "?", file, line: lineNo, col, key, transitions: 0, maps: new Set(), states: [], final: oldS, slow: new Set(), inLib: /index\.mjs$/.test(file) }; sites.set(k, s); }
            s.transitions++;
            if (map && map !== "0x000000000000") s.maps.add(map);
            s.states.push(`${oldS}→${newS}`);
            s.final = newS;
            if (slow) s.slow.add(slow);
        }
    }
    return { sites: [...sites.values()], icRows, unattributed };
}

export function printIcReport({ sites, icRows, unattributed }, { top = 40, all = false, state = null } = {}) {
    const lib = sites.filter((s) => all || s.inLib);
    const byFinal = {};
    for (const s of lib) byFinal[s.final] = (byFinal[s.final] ?? 0) + 1;
    console.log(`IC events: ${icRows} (${unattributed} not attributable to a code object); sites${all ? "" : " in the library bundle"}: ${lib.length}`);
    console.log("final states: " + Object.entries(byFinal).map(([k, n]) => `${STATE_NAME[k] ?? k}=${n}`).join("  "));
    console.log("caveats: optimized code with inlined monomorphic handlers does not log; a site that reached N stays silent afterwards; call-site polymorphism is not an IC event.\n");
    let rows = lib.filter((s) => STATE_RANK[s.final] !== undefined);
    if (state) rows = rows.filter((s) => s.final === state);
    rows.sort((a, b) => (STATE_RANK[b.final] ?? 0) - (STATE_RANK[a.final] ?? 0) || b.maps.size - a.maps.size || b.transitions - a.transitions);
    const out = rows.slice(0, top).map((s) => ({
        state: STATE_NAME[s.final] ?? s.final,
        kind: s.type,
        key: s.key,
        function: s.fn,
        site: `${shortFile(s.file)}:${s.line}:${s.col}`,
        maps: s.maps.size,
        trans: s.transitions,
        path: compressStates(s.states),
        slow: [...s.slow].join("|"),
    }));
    if (out.length === 0) { console.log("no polymorphic/megamorphic/generic sites recorded"); return; }
    const cols = Object.keys(out[0]);
    const width = cols.map((c) => Math.max(c.length, ...out.map((r) => String(r[c]).length)));
    const line = (vals) => vals.map((v, i) => String(v).padEnd(width[i])).join("  ");
    console.log(line(cols));
    console.log(line(width.map((w) => "-".repeat(w))));
    for (const r of out) console.log(line(cols.map((c) => r[c])));
}

function compressStates(states) {
    const seq = [];
    for (const t of states) {
        const [from, to] = t.split("→");
        if (seq.length === 0) seq.push(from);
        if (seq[seq.length - 1] !== to) seq.push(to);
    }
    return seq.join("→");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) { console.error("usage: analyze-ic.mjs <file.v8.log> [--top N] [--all] [--state N|P|G]"); process.exit(1); }
    const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 40;
    const state = args.includes("--state") ? args[args.indexOf("--state") + 1] : null;
    printIcReport(parseIcLog(readFileSync(file, "utf8")), { top, all: args.includes("--all"), state });
}
