// Wire-format what-if: capture the frames a scenario's encoder emits, assign
// every byte to a category (framing, op headers, ref headers, values by shape)
// and project the byte effect of format proposals BEFORE implementing them.
//
//   node bench/lib/wire-whatif.mjs <scenario>[/<variant>] [--build dir] [--ticks 30] [--warm 3] [--fields]
//
// `lib.Encoder.prototype.{encode,encodeView,encodeAll,encodeAllView}` are
// wrapped before the scenario's setup(); each frame is parsed per SPEC.md right
// after it is produced, resolving refIds against the live encoder. `deflate` /
// `zstd` are the frame sizes after general-purpose compression: how much
// redundancy any format change could still remove.
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIOS_DIR = join(ROOT, "bench/scenarios");
const $childType = Symbol.for("$childType");
const $keyType = Symbol.for("$keyType");

const FIXED = { boolean: 1, uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8, int64: 8, uint64: 8, bigint64: 8, biguint64: 8 };

function rv(b, it) { let r = 0, s = 1, x; do { x = b[it.offset++]; r += (x & 0x7f) * s; s *= 128; } while (x & 0x80); return r; }
const vsize = (n) => { let s = 1; while (n >= 0x80) { n = Math.floor(n / 128); s++; } return s; };
const unzig = (z) => (z % 2 === 1) ? -((z + 1) / 2) : z / 2;
const zig = (d) => d >= 0 ? 2 * d : -2 * d - 1;

export class Tally {
    cat = new Map(); fields = new Map(); proj = new Map(); counts = new Map(); errors = new Map();
    bytes = 0; frames = 0; deflate = 0; zstd = 0;
    frameStrings = new Map(); prevRef = 0; // per frame
    add(c, n) { if (n) this.cat.set(c, (this.cat.get(c) ?? 0) + n); }
    count(c) { this.counts.set(c, (this.counts.get(c) ?? 0) + 1); }
    field(f, n) { const e = this.fields.get(f) ?? { n: 0, bytes: 0 }; e.n++; e.bytes += n; this.fields.set(f, e); }
    save(p, n) { if (n) this.proj.set(p, (this.proj.get(p) ?? 0) + n); }
}

/** Size of a dynamic `number` from its first byte (msgpack-shaped). */
function numberSize(tag) {
    if (tag < 0x80 || tag >= 0xe0) return 1;
    if (tag === 0xcc || tag === 0xd0) return 2;
    if (tag === 0xcd || tag === 0xd1) return 3;
    if (tag === 0xce || tag === 0xd2 || tag === 0xca) return 5;
    if (tag === 0xcb) return 9;
    throw new Error(`bad number tag 0x${tag.toString(16)}`);
}

/** Field indexes set in a LEB128-shaped presence mask. */
function readMask(b, it) {
    const bits = [];
    let g = 0, x;
    do { x = b[it.offset++]; for (let i = 0; i < 7; i++) if (x & (1 << i)) bits.push(g * 7 + i); g++; } while (x & 0x80);
    return bits;
}

function normType(t) {
    if (typeof t === "string") return { prim: t };
    if (t && typeof t === "object" && t.quantized) return { prim: t.quantized.wire ?? "uint16", q: true };
    return { ref: true };
}

export function makeParser(encoder, T) {
    const dec = new TextDecoder();
    const info = (refId) => {
        const ref = encoder.root.changeTrees.get(refId)?.ref;
        if (!ref) return null;
        return infoOf(ref);
    };
    const clsCache = new Map();
    const classInfo = (ctor) => {
        let ci = clsCache.get(ctor);
        if (ci) return ci;
        const md = ctor[Symbol.metadata];
        const fields = [];
        for (const k in md) { const i = +k; if (Number.isInteger(i) && md[i]) fields[i] = { name: md[i].name, type: normType(md[i].type) }; }
        ci = { kind: "schema", cls: ctor.name || "?", fields };
        clsCache.set(ctor, ci);
        return ci;
    };
    const infoOf = (ref) => {
        const ctor = ref.constructor, kind = ctor.COLLECTION_KIND;
        if (kind === undefined) return classInfo(ctor);
        return { kind: kind === 2 ? "array" : (kind === 1 ? "map" : "indexed"), cls: ctor.name, child: normType(ref[$childType]), keyType: ref[$keyType] ?? "string" };
    };

    function prim(type, b, it, label, q) {
        const start = it.offset;
        let shape;
        if (type === "number") {
            const tag = b[it.offset];
            const size = numberSize(tag);
            shape = (tag === 0xca) ? "num:f32" : (tag === 0xcb) ? "num:f64" : `num:int${size}`;
            it.offset += size;
            if (size > 1) T.save("number tag bytes (all multi-byte dynamic numbers)", 1);
        } else if (type === "string") {
            const len = rv(b, it);
            const s = dec.decode(b.subarray(it.offset, it.offset + len));
            it.offset += len;
            shape = "string";
            T.add("value string len", it.offset - start - len);
            T.add("value string utf8", len);
            if (len >= 3) { const e = T.frameStrings.get(s) ?? 0; T.frameStrings.set(s, e + 1); if (e >= 1) T.save("string repeats within a frame (table ref ~2B)", Math.max(0, it.offset - start - 2)); }
            T.field(label, it.offset - start);
            return;
        } else if (FIXED[type] !== undefined) {
            it.offset += FIXED[type];
            shape = q ? `quantized:${type}` : type;
            if (type === "boolean") T.save("booleans (7/8 of each, if bit-packed)", 0.875);
        } else throw new Error(`unknown primitive ${type}`);
        T.add(`value ${shape}`, it.offset - start);
        T.field(label, it.offset - start);
    }

    // refValue := uvarint(refId*4 + hasBody*2 + hasTypeId) [typeId] [body]
    function refValue(b, it, ctx) {
        const s = it.offset;
        const h = rv(b, it);
        const refId = Math.floor(h / 4);
        if (h & 1) rv(b, it);
        T.add(`refValue header (${ctx})`, it.offset - s);
        // what-if: delta from the previous refValue of the frame
        const d = vsize(zig(refId - T.prevRef) * 4 + (h & 3));
        T.save("refValue header as delta from previous ref of the frame", (vsize(h)) - d);
        T.prevRef = refId;
        if (h & 2) body(b, it, refId);
    }

    function value(t, b, it, label, ctx) {
        if (t.ref) refValue(b, it, ctx); else prim(t.prim, b, it, label, t.q);
    }

    function body(b, it, refId) {
        const inf = info(refId);
        if (!inf) throw new Error(`body of unresolved refId ${refId}`);
        if (inf.kind === "schema") {
            const s = it.offset;
            const bits = readMask(b, it);
            T.add("body schema mask", it.offset - s);
            T.count("bodies schema");
            for (const i of bits) {
                const f = inf.fields[i];
                if (!f) throw new Error(`body: unknown field ${i} of ${inf.cls}`);
                value(f.type, b, it, `${inf.cls}.${f.name}`, "in schema body");
            }
        } else if (inf.kind === "array") {
            const s = it.offset;
            const r = rv(b, it), count = rv(b, it);
            T.add("body array rev+count", it.offset - s);
            for (let i = 0; i < count; i++) value((r & 1) ? { ref: true } : inf.child, b, it, `${inf.cls}[]`, "in array body");
        } else {
            let s = it.offset;
            const count = rv(b, it);
            T.add("body keyed count", it.offset - s);
            let prevIdx = -1;
            for (let i = 0; i < count; i++) {
                s = it.offset;
                const idx = rv(b, it);
                T.add("body keyed entry index", it.offset - s);
                // what-if: index as delta-1 from the previous entry (dense → 0x00), or a `dense` flag on count
                T.save("keyed body index as delta from previous entry", (it.offset - s) - vsize(zig(idx - prevIdx - 1)));
                if (idx === prevIdx + 1) T.save("keyed body index elided when dense (flag on count)", it.offset - s);
                prevIdx = idx;
                if (inf.kind === "map") {
                    s = it.offset;
                    keyPrim(inf.keyType, b, it);
                    T.add(`body map key (${inf.keyType})`, it.offset - s);
                }
                value(inf.child, b, it, `${inf.cls}<>`, "in keyed body");
            }
        }
    }
    function keyPrim(type, b, it) {
        if (type === "string") { const len = rv(b, it); it.offset += len; }
        else if (type === "number") it.offset += numberSize(b[it.offset]);
        else it.offset += FIXED[type];
    }

    function schemaOps(b, it, end, inf) {
        while (it.offset < end) {
            const s = it.offset;
            const h = rv(b, it);
            const index = Math.floor(h / 4), code = h & 3;
            T.add("schema op header", it.offset - s);
            T.count(`schema op ${["REPLACE", "DELETE", "ADD", "DELETE_AND_ADD"][code]}`);
            if (code === 1) continue;
            const f = inf.fields[index];
            if (!f) throw new Error(`unknown field ${index} of ${inf.cls}`);
            value(f.type, b, it, `${inf.cls}.${f.name}`, "schema op");
        }
    }
    function keyedOps(b, it, end, inf) {
        while (it.offset < end) {
            let s = it.offset;
            const h = rv(b, it);
            const code = h % 4;
            T.add("keyed op header", it.offset - s);
            T.count(`keyed op ${["REPLACE", "DELETE", "ADD", "CLEAR"][code]}`);
            if (code === 2 && inf.kind === "map") { s = it.offset; keyPrim(inf.keyType, b, it); T.add(`map key on ADD (${inf.keyType})`, it.offset - s); }
            if (code === 0 || code === 2) value(inf.child, b, it, `${inf.cls}<>`, "keyed op");
        }
    }
    function arrayOps(b, it, end, inf) {
        while (it.offset < end) {
            const s = it.offset;
            const h = rv(b, it);
            const op = h % 16, arg = Math.floor(h / 16);
            let n = 0, vt = inf.child;
            switch (op) {
                case 1: n = arg; break;
                case 2: n = rv(b, it); break;
                case 3: n = 1; break;
                case 4: rv(b, it); break;
                case 5: case 10: case 9: case 11: break;
                case 6: { const c = rv(b, it); for (let i = 0; i < c; i++) rv(b, it); break; }
                case 7: n = rv(b, it); if (arg & 1) vt = { ref: true }; break;
                case 8: n = 1; vt = { ref: true }; break;
                case 15: { rv(b, it); const l = rv(b, it); it.offset += l; break; }
                default: throw new Error(`array op ${op}`);
            }
            T.add("array op header+operands", it.offset - s);
            T.count(`array op ${op}`);
            for (let i = 0; i < n; i++) value(vt, b, it, `${inf.cls}[]`, "array op");
        }
    }

    return function parse(bytes) {
        T.frames++; T.bytes += bytes.byteLength;
        if (bytes.byteLength === 0) return;
        T.deflate += zlib.deflateRawSync(bytes, { level: 6 }).byteLength;
        if (zlib.zstdCompressSync) T.zstd += zlib.zstdCompressSync(bytes).byteLength;
        T.frameStrings = new Map();
        T.prevRef = 0;
        const it = { offset: 0 };
        let prev = -1;
        while (it.offset < bytes.byteLength) {
            let s = it.offset;
            const h = rv(bytes, it);
            const refId = (h % 2 === 1) ? (h - 1) / 2 : prev + unzig(h / 2);
            prev = refId;
            T.add("chunk header refId", it.offset - s);
            s = it.offset;
            const l = rv(bytes, it);
            const isRun = l % 2 === 1, len = Math.floor(l / 2), end = it.offset + len;
            T.add("chunk length", it.offset - s);
            T.count(isRun ? "runs" : "chunks");
            try {
                if (isRun) {
                    s = it.offset;
                    const typeId = rv(bytes, it);
                    const bits = readMask(bytes, it);
                    const extra = rv(bytes, it);
                    T.add("run header (typeId, mask, count)", it.offset - s);
                    const ci = classInfo(encoder.context.get(typeId));
                    let prevDelta = null;
                    for (let m = 0; m <= extra; m++) {
                        if (m > 0) {
                            s = it.offset;
                            const d = unzig(rv(bytes, it));
                            prev += d;
                            T.add("run member refId delta", it.offset - s);
                            if (d === prevDelta) T.save("run member delta elided when stride repeats (RLE)", it.offset - s);
                            prevDelta = d;
                        }
                        T.count("run members");
                        for (const i of bits) { const f = ci.fields[i]; prim(f.type.prim, bytes, it, `${ci.cls}.${f.name}`, f.type.q); }
                    }
                } else {
                    const inf = info(refId);
                    if (!inf) throw new Error(`unresolved refId ${refId}`);
                    if (inf.kind === "schema") schemaOps(bytes, it, end, inf);
                    else if (inf.kind === "array") arrayOps(bytes, it, end, inf);
                    else keyedOps(bytes, it, end, inf);
                }
                if (it.offset !== end) throw new Error(`length mismatch ${it.offset - end}`);
            } catch (e) {
                const kind = e.message.replace(/\d+/g, "N");
                T.errors.set(kind, (T.errors.get(kind) ?? 0) + 1);
                T.add("UNPARSED", Math.max(0, end - it.offset));
                it.offset = end;
            }
        }
    };
}

export function report(label, T, showFields) {
    if (!T.frames) return;
    const pct = (n) => `${(100 * n / T.bytes).toFixed(1)}%`.padStart(6);
    console.log(`\n== ${label}: ${T.frames} frames, ${(T.bytes / T.frames).toFixed(1)} B/frame   deflate ${pct(T.deflate)}  zstd ${pct(T.zstd)} of raw`);
    const cats = [...T.cat.entries()].sort((a, b) => b[1] - a[1]);
    let values = 0;
    for (const [c, n] of cats) if (c.startsWith("value ")) values += n;
    console.log(`   values ${pct(values)}   structure ${pct(T.bytes - values)}`);
    for (const [c, n] of cats) console.log(`   ${pct(n)}  ${(n / T.frames).toFixed(1).padStart(10)} B/frame  ${c}`);
    console.log("   counts/frame: " + [...T.counts.entries()].map(([k, v]) => `${k}=${(v / T.frames).toFixed(1)}`).join("  "));
    if (T.errors.size) console.log("   ERRORS: " + [...T.errors.entries()].map(([k, v]) => `${k}×${v}`).join("; "));
    console.log("   what-if savings:");
    for (const [p, n] of [...T.proj.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${pct(n)}  ${(n / T.frames).toFixed(1).padStart(10)} B/frame  ${p}`);
    if (showFields) {
        console.log("   top fields:");
        for (const [f, e] of [...T.fields.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 14)) console.log(`   ${pct(e.bytes)}  ${(e.bytes / e.n).toFixed(2)} B avg ×${(e.n / T.frames).toFixed(1)}/frame  ${f}`);
    }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const opt = (n, d) => args.includes(n) ? args[args.indexOf(n) + 1] : d;
    const target = args.find((a, i) => !a.startsWith("--") && !["--ticks", "--warm", "--build"].includes(args[i - 1] ?? ""));
    const ticks = +opt("--ticks", 30), warm = +opt("--warm", 3);
    const buildDir = resolve(opt("--build", join(ROOT, "build")));
    function* walk(dir) { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) yield* walk(p); else if (n.endsWith(".mjs")) yield p; } }
    let found = null;
    for (const file of walk(SCENARIOS_DIR)) {
        const scenario = (await import(pathToFileURL(file).href)).default;
        const variants = scenario.variants ?? [{ name: "default" }];
        if (target === scenario.name || target.startsWith(scenario.name + "/")) {
            const vn = target === scenario.name ? variants[0].name : target.slice(scenario.name.length + 1);
            const variant = variants.find((v) => v.name === vn);
            if (!variant) { console.error(`unknown variant ${vn}: ${variants.map((v) => v.name)}`); process.exit(1); }
            found = { scenario, variant }; break;
        }
    }
    if (!found) { console.error(`no scenario matches ${target}`); process.exit(1); }
    const lib = await import(pathToFileURL(resolve(buildDir, "index.mjs")).href);
    const tallies = { shared: new Tally(), view: new Tally(), all: new Tally() };
    const parsers = new Map();
    let capturing = false;
    const P = lib.Encoder.prototype;
    const handle = (enc, kind, u8) => {
        if (!capturing || !u8) return;
        let ps = parsers.get(enc);
        if (!ps) parsers.set(enc, ps = {});
        (ps[kind] ??= makeParser(enc, tallies[kind]))(u8);
    };
    for (const [name, kind] of [["encode", "shared"], ["encodeAll", "all"]]) {
        const orig = P[name];
        P[name] = function (...a) { const start = a[0]?.offset ?? 0; const out = orig.apply(this, a); handle(this, kind, out.subarray(start)); return out; };
    }
    for (const [name, kind] of [["encodeView", "view"], ["encodeAllView", "all"]]) {
        const orig = P[name];
        P[name] = function (...a) { const out = orig.apply(this, a); handle(this, kind, out[1]); return out; };
    }
    const plan = { warmup: warm, reps: 1, iterations: ticks, totalRuns: warm + ticks };
    const ctx = await found.scenario.setup(lib, found.variant, plan);
    let i = 0;
    for (; i < warm; i++) found.scenario.run(ctx, i);
    capturing = true;
    for (; i < warm + ticks; i++) found.scenario.run(ctx, i);
    capturing = false;
    console.log(`\n######## ${found.scenario.name}/${found.variant.name}`);
    for (const kind of ["shared", "view", "all"]) report(`${kind} frames`, tallies[kind], args.includes("--fields"));
}
