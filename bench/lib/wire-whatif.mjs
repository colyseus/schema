// Wire-format what-if: capture the frames a scenario's encoder emits, parse the
// 6.0 chunk stream, and project the byte effect of format proposals BEFORE
// implementing any of them.
//
//   node bench/lib/wire-whatif.mjs <scenario>[/<variant>] [--build dir] [--ticks 30] [--warm 3]
//
// `lib.Encoder.prototype.{encode,encodeView,encodeAll,encodeAllView}` are
// wrapped before the scenario's setup(), so every frame the tick produces is
// copied out. Parsing follows SPEC.md:
//   message   := chunk*
//   chunk     := uvarint(refId) uvarint(len) ops(len bytes)
//   schemaOp  := uvarint(index << 2 | code) value?      code: 0 REPLACE, 1 DELETE, 2 ADD, 3 DELETE_AND_ADD
//   keyedOp   := uvarint(index * 4 + code) [key] value?  code: 0 REPLACE, 1 DELETE, 2 ADD, 3 CLEAR
//   refValue  := uvarint(refId * 4 + hasBody*2 + hasType) [uvarint typeId] [body]
// Chunks whose ops carry an inline body (ADD of a fresh instance) or that
// belong to an ArraySchema are counted but not parsed op-by-op; the
// projections that need op detail (W2b, W1, W3) only use the parsed chunks.
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS_DIR = join(BENCH_DIR, "scenarios");

const $childType = Symbol.for("$childType");
const $keyType = Symbol.for("$keyType");
const $changes = Symbol.for("$changes");

// --- varint / value readers ---------------------------------------------------

function readUvarint(b, it) {
    let result = 0, shift = 0, byte;
    do { byte = b[it.offset++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return result;
}
export function uvarintSize(n) { let s = 1; while (n >= 0x80) { n = Math.floor(n / 128); s++; } return s; }
function zigzag(n) { return n < 0 ? -2 * n - 1 : 2 * n; }

const FIXED = { boolean: 1, uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8, bigint64: 8, biguint64: 8 };

/** Advance past one primitive value; returns { size, shape } (shape describes `number` encodings). */
function skipPrimitive(type, b, it) {
    if (type === "number") {
        const tag = b[it.offset];
        let size, shape;
        if (tag < 0x80 || tag >= 0xe0) { size = 1; shape = "int1"; }
        else if (tag === 0xcc || tag === 0xd0) { size = 2; shape = "int2"; }
        else if (tag === 0xcd || tag === 0xd1) { size = 3; shape = "int3"; }
        else if (tag === 0xce || tag === 0xd2) { size = 5; shape = "int5"; }
        else if (tag === 0xca) { size = 5; shape = "f32"; }
        else if (tag === 0xcb) { size = 9; shape = "f64"; }
        else throw new Error(`unknown number tag 0x${tag.toString(16)}`);
        it.offset += size;
        return { size, shape };
    }
    if (type === "string") {
        const start = it.offset;
        const len = readUvarint(b, it);
        it.offset += len;
        return { size: it.offset - start, shape: "str" };
    }
    if (FIXED[type] !== undefined) { it.offset += FIXED[type]; return { size: FIXED[type], shape: type }; }
    throw new Error(`unknown primitive ${type}`);
}

function normalizeType(t) {
    if (typeof t === "string") return { prim: t };
    if (typeof t === "function") return { ref: true };
    if (t && typeof t === "object") {
        if (t.quantized) return { prim: t.quantized.wire ?? "uint16", quantized: true };
        return { ref: true };
    }
    return { ref: true };
}

// --- refId → shape resolution (from the live encoder) ------------------------------

function refResolver(encoder) {
    const cache = new Map();
    return (refId) => {
        if (cache.has(refId)) return cache.get(refId);
        const tree = encoder.root.changeTrees?.[refId];
        const ref = tree?.ref;
        let info = null;
        if (ref) {
            const ctor = ref.constructor;
            const kind = ctor.COLLECTION_KIND;
            if (kind === undefined) {
                const md = ctor[Symbol.metadata];
                const fields = [];
                for (const k in md) { const i = +k; if (Number.isInteger(i) && md[i]) fields[i] = { name: md[i].name, type: normalizeType(md[i].type) }; }
                info = { kind: "schema", cls: ctor.name || "?", fields };
            } else {
                const raw = ref[Symbol.for("$proxyTarget")] ?? ref;
                info = { kind: kind === 1 ? "array" : "keyed", cls: ctor.name, child: normalizeType(raw[$childType]), keyType: raw[$keyType] ?? "string" };
            }
        }
        cache.set(refId, info);
        return info;
    };
}

// --- message parser ------------------------------------------------------------------

export function parseMessage(bytes, resolveRef, deltaHeaders = false) {
    const it = { offset: 0 };
    const chunks = [];
    let prevRefId = -1;
    while (it.offset < bytes.byteLength) {
        const start = it.offset;
        let refId = readUvarint(bytes, it);
        if (deltaHeaders) {
            // chunkHeader := uvarint(refId*2+1) | uvarint(zigzag(refId - prev)*2)
            if (refId % 2 === 1) refId = (refId - 1) / 2;
            else { const z = refId / 2; refId = prevRefId + ((z % 2 === 1) ? -((z + 1) / 2) : z / 2); }
            prevRefId = refId;
        }
        const refIdBytes = it.offset - start;
        const lenStart = it.offset;
        let len = readUvarint(bytes, it);
        let isRun = false;
        if (deltaHeaders) { isRun = (len % 2 === 1); len = (len - (len % 2)) / 2; } // length prefix `byteLen*2 + runFlag`
        const lenBytes = it.offset - lenStart;
        const bodyStart = it.offset, bodyEnd = bodyStart + len;
        const info = resolveRef(refId);
        const chunk = { refId, refIdBytes, lenBytes, bodyBytes: len, cls: info?.cls ?? "?", kind: isRun ? "run" : (info?.kind ?? "unknown"), ops: null, mask: 0, opHeaderBytes: 0, valueBytes: 0, shapes: [], members: 1 };
        if (isRun) {
            // runBody := uvarint(typeId) mask64 uvarint(extra) values { uvarint(zigzag(Δ)) values }×extra — already the W2b shape
            const rit = { offset: bodyStart };
            readUvarint(bytes, rit); // typeId
            while (bytes[rit.offset++] & 0x80) { /* mask groups */ }
            chunk.members = 1 + readUvarint(bytes, rit);
            chunk.opHeaderBytes = rit.offset - bodyStart;
            chunk.valueBytes = bodyEnd - rit.offset;
            chunk.ops = [];
        }
        else if (info?.kind === "schema") chunk.ops = parseSchemaOps(bytes, bodyStart, bodyEnd, info, chunk);
        else if (info?.kind === "keyed") chunk.ops = parseKeyedOps(bytes, bodyStart, bodyEnd, info, chunk);
        it.offset = bodyEnd;
        chunks.push(chunk);
    }
    return chunks;
}

function parseSchemaOps(b, start, end, info, chunk) {
    const it = { offset: start };
    const ops = [];
    try {
        while (it.offset < end) {
            const hStart = it.offset;
            const h = readUvarint(b, it);
            const index = h >>> 2, code = h & 3;
            const hBytes = it.offset - hStart;
            const field = info.fields[index];
            if (!field) throw new Error("unknown field");
            const op = { index, code, name: field.name, headerBytes: hBytes, valueBytes: 0, shape: null };
            if (code !== 1) {
                if (field.type.ref) {
                    const rh = readUvarint(b, it);
                    if (rh & 1) readUvarint(b, it);
                    if (rh & 2) throw new Error("inline body"); // fresh instance body: not parsed
                    op.valueBytes = it.offset - hStart - hBytes;
                    op.shape = "ref";
                } else {
                    const v = skipPrimitive(field.type.prim, b, it);
                    op.valueBytes = v.size;
                    op.shape = field.type.quantized ? `q:${v.shape}` : v.shape;
                }
            }
            ops.push(op);
            chunk.mask |= (1 << (index & 31));
            chunk.opHeaderBytes += hBytes;
            chunk.valueBytes += op.valueBytes;
            chunk.shapes.push(`${field.name}:${op.shape ?? "del"}`);
        }
        if (it.offset !== end) throw new Error("length mismatch");
    } catch (e) {
        chunk.unparsed = e.message;
        chunk.opHeaderBytes = 0; chunk.valueBytes = 0; chunk.mask = 0; chunk.shapes = [];
        return null;
    }
    return ops;
}

function parseKeyedOps(b, start, end, info, chunk) {
    const it = { offset: start };
    const ops = [];
    try {
        while (it.offset < end) {
            const hStart = it.offset;
            const h = readUvarint(b, it);
            const index = Math.floor(h / 4), code = h % 4;
            const hBytes = it.offset - hStart;
            const op = { index, code, headerBytes: hBytes, keyBytes: 0, valueBytes: 0 };
            if (code === 2) { const k0 = it.offset; skipPrimitive(info.keyType, b, it); op.keyBytes = it.offset - k0; }
            if (code === 0 || code === 2) {
                if (info.child.ref) {
                    const rh = readUvarint(b, it);
                    if (rh & 1) readUvarint(b, it);
                    if (rh & 2) throw new Error("inline body");
                    op.valueBytes = it.offset - hStart - hBytes - op.keyBytes;
                } else {
                    op.valueBytes = skipPrimitive(info.child.prim, b, it).size;
                }
            }
            ops.push(op);
            chunk.opHeaderBytes += hBytes;
            chunk.valueBytes += op.valueBytes + op.keyBytes;
        }
        if (it.offset !== end) throw new Error("length mismatch");
    } catch (e) {
        chunk.unparsed = e.message;
        chunk.opHeaderBytes = 0; chunk.valueBytes = 0;
        return null;
    }
    return ops;
}

// --- projections -----------------------------------------------------------------------

export function project(messages) {
    const t = { messages: messages.length, bytes: 0, chunks: 0, refIdBytes: 0, lenBytes: 0, opHeaderBytes: 0, valueBytes: 0, unparsedChunks: 0, unparsedBytes: 0,
        w2aSorted: 0, w2aInOrder: 0, w2bSaved: 0, w2bChunks: 0, w1Saved: 0, w1Count: 0, w3Saved: 0, w3Count: 0, oneOpChunks: 0, numberShapes: new Map(), classes: new Map() };
    for (const chunks of messages) {
        let msgBytes = 0;
        // refId header alternatives
        const ids = chunks.map((c) => c.refId);
        const sorted = [...ids].sort((a, b) => a - b);
        let prevS = 0, prevO = 0;
        for (let i = 0; i < ids.length; i++) {
            t.w2aSorted += uvarintSize(sorted[i] - prevS); prevS = sorted[i];
            t.w2aInOrder += uvarintSize(zigzag(ids[i] - prevO)); prevO = ids[i];
        }
        // same-shape runs: consecutive-in-sorted-order chunks of one class with one mask, all-REPLACE primitives
        const groups = new Map();
        for (const c of chunks) {
            msgBytes += c.refIdBytes + c.lenBytes + c.bodyBytes;
            t.chunks++;
            if (c.kind === "run") { t.runs = (t.runs ?? 0) + 1; t.runMembers = (t.runMembers ?? 0) + c.members; t.refIdBytes += c.refIdBytes; t.lenBytes += c.lenBytes; t.opHeaderBytes += c.opHeaderBytes; t.valueBytes += c.valueBytes; continue; }
            t.refIdBytes += c.refIdBytes; t.lenBytes += c.lenBytes;
            if (c.ops === null) { t.unparsedChunks++; t.unparsedBytes += c.refIdBytes + c.lenBytes + c.bodyBytes; continue; }
            t.opHeaderBytes += c.opHeaderBytes; t.valueBytes += c.valueBytes;
            if (c.ops.length === 1) t.oneOpChunks++;
            const cls = t.classes.get(c.cls) ?? { chunks: 0, bytes: 0, ops: 0 };
            cls.chunks++; cls.bytes += c.refIdBytes + c.lenBytes + c.bodyBytes; cls.ops += c.ops.length; t.classes.set(c.cls, cls);
            for (const op of c.ops) {
                if (op.shape && /^(int1|int2|int3|int5|f32|f64)$/.test(op.shape)) {
                    t.numberShapes.set(op.shape, (t.numberShapes.get(op.shape) ?? 0) + 1);
                    if (op.shape === "f32") { t.w1Saved += 1; t.w1Count++; t.w3Saved += 3; t.w3Count++; }   // 0xca+4 → float32 4 → quantized uint16 2
                    if (op.shape === "f64") { t.w1Saved += 5; t.w1Count++; t.w3Saved += 7; t.w3Count++; }
                }
            }
            // primitive sets travel as ADD (code 2) as well as REPLACE (code 0)
            if (c.kind === "schema" && c.ops.every((o) => (o.code === 0 || o.code === 2) && o.shape !== "ref")) {
                const key = `${c.cls}|${c.mask}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(c);
            }
        }
        for (const [, g] of groups) {
            if (g.length < 2) continue;
            const current = g.reduce((s, c) => s + c.refIdBytes + c.lenBytes + c.opHeaderBytes + c.valueBytes, 0);
            const fieldCount = g[0].ops.length;
            const header = 1 + 1 + uvarintSize(g[0].mask) + uvarintSize(g.length);       // RUN op, typeId, mask, count
            const ids2 = g.map((c) => c.refId).sort((a, b) => a - b);
            let prev = 0, body = 0;
            for (let i = 0; i < g.length; i++) { body += uvarintSize(ids2[i] - prev); prev = ids2[i]; }
            body += g.reduce((s, c) => s + c.valueBytes, 0);
            t.w2bSaved += current - (header + body);
            t.w2bChunks += g.length;
            void fieldCount;
        }
        t.bytes += msgBytes;
    }
    return t;
}

export function printProjection(label, t) {
    const pct = (n) => t.bytes ? `${(100 * n / t.bytes).toFixed(1)}%` : "-";
    const per = (n) => (n / t.messages).toFixed(1);
    console.log(`\n== ${label}: ${t.messages} messages, ${per(t.bytes)} B/message, ${per(t.chunks)} chunks/message`);
    console.log(`   refId headers ${pct(t.refIdBytes)}  len headers ${pct(t.lenBytes)}  op headers ${pct(t.opHeaderBytes)}  values ${pct(t.valueBytes)}  unparsed chunks ${t.unparsedChunks} (${pct(t.unparsedBytes)}: inline bodies / arrays)`);
    if (t.oneOpChunks) console.log(`   single-op chunks: ${per(t.oneOpChunks)}/message`);
    if (t.runs) console.log(`   same-shape runs: ${per(t.runs)}/message covering ${per(t.runMembers)} structures/message`);
    const shapes = [...t.numberShapes.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
    if (shapes) console.log(`   "number" encodings seen: ${shapes}`);
    const classes = [...t.classes.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6).map(([k, v]) => `${k} ${pct(v.bytes)} (${(v.ops / v.chunks).toFixed(1)} ops/chunk)`).join(", ");
    if (classes) console.log(`   by class: ${classes}`);
    const rows = [
        ["W2a refId delta (chunks sorted by refId)", t.refIdBytes - t.w2aSorted],
        ["W2a refId delta (emission order, zigzag)", t.refIdBytes - t.w2aInOrder],
        ["W2b same-shape RUN op (sorted, all-REPLACE primitive chunks)", t.w2bSaved],
        ["W1 float32 instead of fractional \"number\"", t.w1Saved],
        ["W3 quantized uint16 instead of fractional \"number\"", t.w3Saved],
        ["W2a+W2b combined (RUN over delta ids)", t.w2bSaved + (t.refIdBytes - t.w2aSorted) * 0], // RUN already uses deltas inside groups
    ];
    for (const [name, saved] of rows) console.log(`   ${name.padEnd(64)} −${per(saved).padStart(8)} B/message  (${pct(saved)})`);
}

// --- CLI --------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const opt = (n, d) => args.includes(n) ? args[args.indexOf(n) + 1] : d;
    const target = args.find((a, i) => !a.startsWith("--") && !["--build", "--ticks", "--warm"].includes(args[i - 1] ?? ""));
    const buildDir = resolve(opt("--build", resolve(BENCH_DIR, "..", "build")));
    const ticks = +opt("--ticks", 30), warm = +opt("--warm", 3);
    const deltaHeaders = args.includes("--delta"); // build already emits delta chunk headers (the W2a projection is then "already applied")
    if (!target) { console.error("usage: wire-whatif.mjs <scenario>[/<variant>] [--build dir] [--ticks 30]"); process.exit(1); }

    function* walk(dir) { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) yield* walk(p); else if (n.endsWith(".mjs")) yield p; } }
    let found = null;
    for (const file of walk(SCENARIOS_DIR)) {
        const scenario = (await import(pathToFileURL(file).href)).default;
        const variants = scenario.variants ?? [{ name: "default" }];
        if (target === scenario.name || target.startsWith(scenario.name + "/")) {
            const vn = target === scenario.name ? variants[0].name : target.slice(scenario.name.length + 1);
            const variant = variants.find((v) => v.name === vn);
            if (!variant) { console.error(`unknown variant ${vn}`); process.exit(1); }
            found = { scenario, variant }; break;
        }
    }
    if (!found) { console.error(`no scenario matches ${target}`); process.exit(1); }

    const lib = await import(pathToFileURL(resolve(buildDir, "index.mjs")).href);
    const captured = { shared: [], view: [], all: [] };
    let capturing = false;
    const encoders = new Set();
    const P = lib.Encoder.prototype;
    const copy = (u8) => u8.slice();
    for (const [name, kind] of [["encode", "shared"], ["encodeAll", "all"]]) {
        const orig = P[name];
        P[name] = function (...a) { const out = orig.apply(this, a); encoders.add(this); if (capturing) captured[kind].push(copy(out)); return out; };
    }
    for (const [name, kind] of [["encodeView", "view"], ["encodeAllView", "all"]]) {
        const orig = P[name];
        P[name] = function (...a) { const out = orig.apply(this, a); encoders.add(this); if (capturing) captured[kind].push(copy(out[1])); return out; };
    }
    const plan = { warmup: warm, reps: 1, iterations: ticks, totalRuns: warm + ticks };
    const ctx = await found.scenario.setup(lib, found.variant, plan);
    let i = 0;
    for (; i < warm; i++) found.scenario.run(ctx, i);
    capturing = true;
    for (; i < warm + ticks; i++) found.scenario.run(ctx, i);
    capturing = false;
    const encoder = [...encoders].pop();
    if (!encoder) { console.error("scenario produced no encoder frames (decode-only unit?)"); process.exit(1); }
    const resolveRef = refResolver(encoder);
    console.log(`wire what-if: ${found.scenario.name}/${found.variant.name} (${ticks} ticks after ${warm} warm-up) against ${buildDir}`);
    for (const kind of ["shared", "view", "all"]) {
        if (captured[kind].length === 0) continue;
        const msgs = captured[kind].filter((m) => m.byteLength > 0).map((m) => parseMessage(m, resolveRef, deltaHeaders));
        if (msgs.length) printProjection(`${kind} frames`, project(msgs));
    }
}
