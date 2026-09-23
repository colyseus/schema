import { ARRAY_OP, KEYED_OP, KEYED_OP_CODE, KIND_ARRAY, KIND_MAP, KIND_SCHEMA, OPERATION, REF_HAS_BODY, REF_HAS_TYPE } from "../encoding/spec.js";
import type { Iterator } from "../encoding/decode.js";
import { encode } from "../encoding/encode.js";
import { uvarint, writeMask64, writeString, endChunk } from "../encoding/varint.js";
import { $childType, $getByIndex, $keyType } from "../types/symbols.js";
import { Metadata } from "../Metadata.js";
import { isQuantizedType, makeQuantizedEncoder } from "../types/quantize.js";
import { IS_FILTERED, type ChangeTree, refTreeOf, refIdOf, viewTreeOf } from "./ChangeTree.js";
import type { EncodeDescriptor } from "./EncodeDescriptor.js";
import type { StateView } from "./StateView.js";
import { ARRAY_SNAPSHOT } from "./StateView.js";
import type { TypeContext } from "../types/TypeContext.js";
import type { ArrayLog } from "./ArrayLog.js";
import type { KeyedRecorder } from "./KeyedRecorder.js";
import type { RefTable } from "../RefTable.js";
import { isEdgeLive } from "./changeTree/parentChain.js";

export const MODE_SNAPSHOT = 0;
export const MODE_PATCH = 1;
export const MODE_DRAIN = 2;
/** Stream broadcast pass: element bodies inline from the live structure, `@unreliable` fields excluded. */
export const MODE_STREAM = 3;

// module constants keep the hot path off the enum object
const OP_ADD = OPERATION.ADD;
const OP_DELETE = OPERATION.DELETE;

// canInline() results
const NO_BODY = 0;
const BODY_LIVE_A = 1;     // live structure, stamp genA (entry consumed; recorder ops still owed)
const BODY_LIVE_B = 2;     // live structure, stamp genB
const BODY_RECORDER_B = 3; // recorder-sourced, stamp genB

type ValueWriter = (bytes: Uint8Array, value: any, it: Iterator) => void;

/**
 * Encode context: the pass-level state (buffer, view, stamps — set once per
 * entry point) and the current tree's state on one object, so the per-field
 * hot path reads everything one hop away. Frames come from a depth-indexed
 * pool: depth 0 is the pass itself; an inline body runs on the next frame
 * with the pass fields copied over, so it never clobbers the parent's tree
 * state.
 */
export interface Frame {
    // ── pass ──
    context: TypeContext;
    buffer: Uint8Array;
    it: Iterator;
    capacity: number;
    view: StateView | undefined;
    hasView: boolean;
    emitFiltered: boolean;
    mode: number;
    genA: number;
    genB: number;
    /**
     * refId of the previous chunk written in this slice; -1 before the first
     * one. Chunk headers are `uvarint(refId*2+1)` (absolute) for the first
     * chunk of a slice and `uvarint(zigzag(refId - prevRefId)*2)` after it —
     * consecutive dirty structures usually have neighbouring refIds, so the
     * delta stays one byte long after absolute ids have grown past 127.
     */
    prevRefId: number;
    // ── tree ──
    depth: number;
    tree: ChangeTree;
    ref: any;
    refTarget: any;
    /** Element storage for arrays (the raw array: `tree.refTarget`). */
    elements: any;
    /** `ref[$values]` — read once per tree, not per field (undefined on collections). */
    values: any[];
    desc: EncodeDescriptor;
    kind: number;
    treeIsFiltered: boolean;
    /**
     * Bit i set iff field i (< 32) belongs to this pass: the class's `@view`
     * bits for the view pass, their complement for the shared pass, and all
     * or nothing when the tree itself is filtered — one AND per field.
     */
    emitMask: number;
    filter: ((ref: any, index: number, view?: StateView) => boolean) | undefined;
    childType: any;
    childEncoder: ValueWriter | undefined;
    /** MapSchema key writer per the map's declared key type (`writeString` for string maps); undefined on every other kind. */
    keyWriter: ValueWriter | undefined;
    /** Collection whose children are refs (Schema instances). */
    isSchemaChild: boolean;
    /** Filtered Schema-child array in a view pass: identity ops (ADD_REF / DELETE_REF), no positions. */
    identityMode: boolean;
    /** Position of the chunk's reserved length byte; -1 while no chunk is open. */
    lenPos: number;
    // body scratch: mask bits + the values (and map keys) that passed the gate
    maskLow: number;
    maskHigh: number;
    vals: any[];
    keys: number[];
    /** Map keys of the scratch entries (string or number per the map's key type). */
    strs: any[];
    /**
     * High-water marks of `vals` / `strs` since the last `releaseFrames`:
     * every body writer raises them to the entries it filled, so the release
     * clears exactly those (a one-chunk tick touches none and pays nothing).
     * `keys` holds numbers only and is never cleared.
     */
    valsLen: number;
    strsLen: number;
    /** Entry a DRAIN body is sourced from (set by `canInline`, consumed by `writeBody`). */
    entryForBody: Map<number | ChangeTree, OPERATION> | undefined;
}

const framePool: Frame[] = [];

/** Frame for `depth` (created on first use). Exported for the frame-pool tests only. */
export function frameAt(depth: number): Frame {
    let f = framePool[depth];
    if (f === undefined) {
        f = framePool[depth] = {
            context: undefined!, buffer: undefined!, it: undefined!, capacity: 0, view: undefined, hasView: false,
            emitFiltered: false, mode: MODE_SNAPSHOT, genA: 0, genB: 0, prevRefId: -1,
            depth, tree: undefined!, ref: undefined, refTarget: undefined, elements: undefined, values: undefined!, desc: undefined!, kind: 0,
            treeIsFiltered: false, emitMask: 0, filter: undefined, childType: undefined, childEncoder: undefined, keyWriter: undefined,
            isSchemaChild: false, identityMode: false,
            lenPos: -1, maskLow: 0, maskHigh: 0, vals: [], keys: [], strs: [], valsLen: 0, strsLen: 0, entryForBody: undefined,
        };
    }
    return f;
}

/** The pass frame (depth 0). The entry point fills the pass fields before use. */
export function passFrame(): Frame {
    return frameAt(0);
}

/**
 * Drop the tree references every frame of the finished pass still holds, so
 * a disposed state can be collected. Frames are entered in depth order
 * (`childFrame` = parent depth + 1), so the first frame without a tree ends
 * the used range. Scratch is cleared up to its high-water mark and never
 * truncated: `length = 0` makes V8 drop the backing store, and the next body
 * pass would regrow it.
 */
export function releaseFrames(): void {
    for (let i = 0; i < framePool.length; i++) {
        const f = framePool[i];
        if (f.tree === undefined) break;
        f.tree = undefined!;
        f.ref = undefined;
        f.refTarget = undefined;
        f.elements = undefined;
        f.values = undefined!;
        f.entryForBody = undefined;
        if (f.valsLen !== 0) releaseScratch(f); // strs are only ever filled alongside vals
    }
}

/** Out of line: only frames that wrote a body reach it. */
function releaseScratch(f: Frame): void {
    const vals = f.vals;
    for (let k = 0, n = f.valsLen; k < n; k++) vals[k] = undefined;
    f.valsLen = 0;
    const strs = f.strs;
    for (let k = 0, n = f.strsLen; k < n; k++) strs[k] = undefined;
    f.strsLen = 0;
}

/** Raise the frame's scratch high-water marks after a body filled `n` sequential entries (`strs` only for maps). */
function noteScratch(f: Frame, n: number, withStrs: boolean): void {
    if (n > f.valsLen) f.valsLen = n;
    if (withStrs && n > f.strsLen) f.strsLen = n;
}

/** Load `tree` into `f` (tree fields only). Straight-line on purpose: it must inline into the patch loop. */
export function enterFrame(f: Frame, tree: ChangeTree): void {
    const desc = tree.encDescriptor;
    const refTarget = tree.refTarget as any;
    const treeIsFiltered = (tree.flags & IS_FILTERED) !== 0;
    // Per-instance child type. A Schema tree has none, and probing for it is a
    // megamorphic MISS (full prototype-chain walk) on every Schema instance —
    // 8.7 % of a bulk-ADD encode — so only collections are asked.
    const childType = (desc.kind === KIND_SCHEMA) ? undefined : refTarget[$childType];
    f.tree = tree;
    f.ref = tree.ref;
    f.refTarget = refTarget;
    f.elements = tree.refTarget;
    f.values = tree.values!; // the tree's cached `$values` (monomorphic load); undefined on collections
    f.desc = desc;
    f.kind = desc.kind;
    f.treeIsFiltered = treeIsFiltered;
    const filterBits = treeIsFiltered ? -1 : desc.filterBitmask;
    f.emitMask = f.emitFiltered ? filterBits : ~filterBits;
    f.filter = desc.filter;
    f.childType = childType;
    const childEncoder = childWriterOf(childType);
    f.childEncoder = childEncoder;
    f.keyWriter = (desc.kind === KIND_MAP) ? keyWriterOf(refTarget[$keyType]) : undefined;
    f.isSchemaChild = childType !== undefined && childEncoder === undefined;
    f.identityMode = f.hasView && treeIsFiltered && f.isSchemaChild && desc.kind === KIND_ARRAY;
    f.lenPos = -1;
}

/** Writer for a collection's child type (live `encode` table); `undefined` for ref children. */
function childWriterOf(type: any): ValueWriter | undefined {
    if (type === undefined) return undefined;
    if (typeof type === "string") return (encode as any)[type];
    if (isQuantizedType(type)) return makeQuantizedEncoder(type.quantized);
    return undefined;
}

/** Writer for a MapSchema's declared key type; string (or undeclared) keys ride as `string`. */
function keyWriterOf(keyType: string | undefined): ValueWriter {
    return (keyType === undefined || keyType === "string") ? writeString : (encode as any)[keyType];
}

/** Frame for an inline body of `child` under `parent`. */
function childFrame(parent: Frame, child: ChangeTree): Frame {
    const f = frameAt(parent.depth + 1);
    f.context = parent.context;
    f.buffer = parent.buffer;
    f.it = parent.it;
    f.capacity = parent.capacity;
    f.view = parent.view;
    f.hasView = parent.hasView;
    f.emitFiltered = parent.emitFiltered;
    f.mode = parent.mode;
    f.genA = parent.genA;
    f.genB = parent.genB;
    enterFrame(f, child);
    return f;
}

// The chunk open/close pair keeps its 1–2 byte refId and < 128 length cases
// inline and the rest out of line, so the patch loop fits V8's cumulative
// inlining budget (a cold call site costs no budget until it runs).
export function openChunk(f: Frame): void {
    writeChunkHeader(f, f.tree.refId); // refId read only when a chunk actually opens
    f.lenPos = f.it.offset++;            // reserve the length byte
}

/**
 * Chunk header only (no length byte): absolute `refId*2+1` for the first
 * chunk of a slice, `zigzag(refId - prevRefId)*2` for the following ones.
 * Also used by the per-view chunk cache, which replays a cached body under
 * a header computed against the receiving view's own previous chunk.
 */
export function writeChunkHeader(f: Frame, refId: number): void {
    const prev = f.prevRefId;
    f.prevRefId = refId;
    let h: number;
    if (prev < 0) h = refId * 2 + 1;
    else {
        const d = refId - prev;
        h = (d < 0) ? (-4 * d - 2) : (4 * d); // zigzag(d) * 2
    }
    if (h >= 0x4000) { uvarint(f.buffer, h, f.it); return; }
    const it = f.it;
    const buffer = f.buffer;
    let o = it.offset;
    if (h < 0x80) {
        buffer[o++] = h;
    } else {
        buffer[o++] = (h & 0x7f) | 0x80;
        buffer[o++] = h >>> 7;
    }
    it.offset = o;
}


/** Length prefix `uvarint(byteLen * 2)`: the low bit is the run flag (see `closeRun`). */
export function closeChunk(f: Frame): void {
    const lenPos = f.lenPos;
    if (lenPos === -1) return;
    f.lenPos = -1;
    const v = (f.it.offset - lenPos - 1) * 2;
    if (v < 0x80) f.buffer[lenPos] = v;
    else closeChunkLong(f, lenPos, 0);
}

/** Same as `closeChunk` with the run flag set: `uvarint(byteLen * 2 + 1)`. */
function closeRun(f: Frame): void {
    const lenPos = f.lenPos;
    f.lenPos = -1;
    const v = (f.it.offset - lenPos - 1) * 2 + 1;
    if (v < 0x80) f.buffer[lenPos] = v;
    else closeChunkLong(f, lenPos, 1);
}

function closeChunkLong(f: Frame, lenPos: number, flag: number): void {
    endChunk(f.buffer, lenPos, f.it, f.capacity, flag);
}

// ── same-shape runs ──────────────────────────────────────────────────────
//
// `run := chunkHeader uvarint(byteLen*2+1) uvarint(typeId) mask64 uvarint(extra)
//         values { uvarint(zigzag(refId_k − refId_k−1)) values }×extra`
//
// Consecutive dirty Schemas of one class whose dirty fields are the same set
// of primitives, all written (ADD), collapse into one chunk: the class and
// the field mask ride once, each member costs its refId delta plus its values
// — no per-member length, no per-field op byte. On a room of N same-class
// entities updating the same fields per tick this is ~19 % of the patch.

/**
 * Can `tree` be a run member in this pass? Schema, ≤ 8 fields (inline op
 * bytes), no per-class filter function, no stream fields, every dirty field a
 * primitive written with ADD, and — in the shared pass — none of them
 * `@view`-tagged (a filtered tree in the view pass emits all its fields).
 */
export function runEligible(tree: ChangeTree, _treeIsFiltered: boolean): boolean {
    if (tree.ops !== undefined || tree.dirtyHigh !== 0) return false;
    const low = tree.dirtyLow;
    if (low === 0) return false;
    const desc = tree.encDescriptor;
    if (!desc.runnable) return false;
    if ((low & desc.refTypeBitmask) !== 0) return false;
    // no `@view`-tagged dirty field: the stock filter passes untagged fields
    // unconditionally in both passes, tagged ones need the per-view check
    if ((low & desc.filterBitmask) !== 0) return false;
    // every dirty op must be ADD (0x80): op bytes are packed 4 per number
    let bits = low;
    const ol = tree.opsLow, oh = tree.opsHigh;
    while (bits !== 0) {
        const bit = bits & -bits;
        const index = 31 - Math.clz32(bit);
        bits ^= bit;
        if ((((index < 4 ? ol : oh) >>> ((index & 3) << 3)) & 0xFF) !== OPERATION.ADD) return false;
    }
    return true;
}

/** Same run as `first`: same class descriptor and the same dirty field set (ops are all ADD by eligibility). */
export function runContinues(first: ChangeTree, next: ChangeTree, treeIsFiltered: boolean): boolean {
    return next.encDescriptor === first.encDescriptor
        && next.dirtyLow === first.dirtyLow
        && runEligible(next, treeIsFiltered);
}

/** Open a run for `first` (frame already entered): header, length byte, typeId, mask, member count. */
export function openRun(f: Frame, first: ChangeTree, extra: number): void {
    writeChunkHeader(f, first.refId);
    f.lenPos = f.it.offset++;
    const typeId = f.context.getTypeId(first.ref.constructor);
    uvarint(f.buffer, typeId!, f.it);
    writeMask64(f.buffer, first.dirtyLow, 0, f.it);
    uvarint(f.buffer, extra, f.it);
    writeRunValues(f, first.values, first.dirtyLow);
}

/** One more run member: refId delta from the previous member, then its values. */
export function addRunMember(f: Frame, tree: ChangeTree): void {
    const refId: number = tree.refId;
    const d = refId - f.prevRefId;
    uvarint(f.buffer, (d < 0) ? (-2 * d - 1) : (2 * d), f.it);
    f.prevRefId = refId;
    writeRunValues(f, tree.values!, tree.dirtyLow);
}

export function endRun(f: Frame): void {
    closeRun(f);
}

/** The values of the masked fields in ascending field order, each with its declared primitive writer. */
function writeRunValues(f: Frame, values: any[], mask: number): void {
    const desc = f.desc;
    const buffer = f.buffer;
    const it = f.it;
    while (mask !== 0) {
        const bit = mask & -mask;
        const index = 31 - Math.clz32(bit);
        mask ^= bit;
        desc.encoders[index]!(buffer, values[index], it);
    }
}

/** Schema field gate: filter class of the field, then the class filter; the stream pass drops `@unreliable`. */
function schemaFieldPasses(f: Frame, index: number): boolean {
    if (index < 32 ? (f.emitMask & (1 << index)) === 0 : wideFieldFiltered(f, index) !== f.emitFiltered) return false;
    if (f.mode === MODE_STREAM && fieldIsUnreliable(f, index)) return false;
    return f.filter === undefined || classFilterPasses(f, index);
}

/** Per-instance `[$filter]` of `@view` classes; out of line so it costs inlining budget only where such classes exist. */
function classFilterPasses(f: Frame, index: number): boolean {
    return f.filter!(f.ref, index, f.view);
}

/** Fields past the bitmask (index ≥ 32); out of line so it costs inlining budget only where such classes exist. */
function wideFieldFiltered(f: Frame, index: number): boolean {
    return f.treeIsFiltered || f.desc.tags[index] !== undefined;
}

function fieldIsUnreliable(f: Frame, index: number): boolean {
    const desc = f.desc;
    if (!desc.hasAnyUnreliable) return false;
    if (index < 32) return (desc.unreliableBitmask & (1 << index)) !== 0;
    return Metadata.hasUnreliableAtIndex(desc.metadata, index);
}

// ── recorder walk ────────────────────────────────────────────────────────

/**
 * Emit every pending op of the frame's tree (patch / per-view tick chunk).
 * Walks the recorder storage directly: a shared callback site would go
 * megamorphic and its callback never inline.
 */
export function encodeTreeOps(f: Frame): void {
    if (f.kind === KIND_SCHEMA) encodeSchemaOps(f);
    else if (f.kind === KIND_ARRAY) encodeArrayLog(f);
    else encodeKeyedOps(f);
}

export function encodeSchemaOps(f: Frame): void {
    const tree = f.tree;
    const ops = tree.ops;
    if (ops !== undefined) { encodeSchemaBits(f, tree.dirtyLow, tree.dirtyHigh, ops); return; }
    // ≤ 8 fields: op bytes packed in opsLow (0–3) / opsHigh (4–7)
    const ol = tree.opsLow;
    const oh = tree.opsHigh;
    let low = tree.dirtyLow;
    while (low !== 0) {
        const bit = low & -low;
        const index = 31 - Math.clz32(bit);
        low ^= bit;
        schemaFieldOp(f, index, ((index < 4 ? ol : oh) >>> ((index & 3) << 3)) & 0xFF);
    }
}

/** Dirty-bit walk over an explicit op table (wide Schemas, unreliable recorders); out of line so it only inlines where it runs. */
export function encodeSchemaBits(f: Frame, low: number, high: number, ops: Uint8Array): void {
    while (low !== 0) {
        const bit = low & -low;
        const index = 31 - Math.clz32(bit);
        low ^= bit;
        schemaFieldOp(f, index, ops[index]);
    }
    while (high !== 0) {
        const bit = high & -high;
        const index = 63 - Math.clz32(bit);
        high ^= bit;
        schemaFieldOp(f, index, ops[index]);
    }
}

function schemaFieldOp(f: Frame, index: number, op: number): void {
    if (!schemaFieldPasses(f, index)) return;
    if (f.lenPos === -1) openChunk(f);
    emitSchemaOp(f, index, op);
}

/** Keyed collections (Map / Set / Collection / Stream): CLEAR first, then the per-index ops in record order. */
export function encodeKeyedOps(f: Frame): void {
    // every collection op carries the tree's filter class (CLEAR included)
    if (f.treeIsFiltered !== f.emitFiltered) return;
    const rec = f.tree.rec as KeyedRecorder | undefined;
    if (rec === undefined) return;
    if (rec.cleared) {
        if (f.lenPos === -1) openChunk(f);
        f.buffer[f.it.offset++] = KEYED_OP.CLEAR;
    }
    // first-record order = wire order
    const order = rec.order;
    for (let k = 0, n = rec.count; k < n; k++) {
        const index = order[k];
        keyedOp(f, index, rec.opAt(index)!);
    }
}

function keyedOp(f: Frame, index: number, op: OPERATION): void {
    if (f.filter !== undefined && !f.filter(f.ref, index, f.view)) return;
    if (f.lenPos === -1) openChunk(f);
    emitKeyedOp(f, index, op);
}

/**
 * ArraySchema: walk the op log. Positional arrays replay the log verbatim
 * (behind a `BASE baseSeq` op when a snapshot was taken this tick, so a
 * client snapshotted mid-tick skips what it already holds); filtered
 * Schema-child arrays in a view pass derive identity ops from the captured
 * values instead. Every op is `uvarint(arg * 16 + op)`: the first operand
 * rides in the op's own varint.
 */
export function encodeArrayLog(f: Frame): void {
    if (f.treeIsFiltered !== f.emitFiltered) return;
    const log = f.tree.rec as ArrayLog | undefined;
    if (log === undefined || log.ops.length === 0) return;
    if (f.identityMode) encodeArrayIdentity(f, log);
    else encodeArrayPositional(f, log);
}

function encodeArrayPositional(f: Frame, log: ArrayLog): void {
    if (f.lenPos === -1) openChunk(f);
    const bytes = f.buffer;
    const it = f.it;
    // A snapshot taken this tick left some client at a revision inside the
    // pending range: say where the log resumes. Otherwise every client sits
    // at the revision the previous tick ended on and resumes from its own.
    if (log.snapRev > log.baseSeq) uvarint(bytes, log.baseSeq * 16 + ARRAY_OP.BASE, it);
    const ops = log.ops;
    const vals = log.vals;
    const type = f.childType;
    const enc = f.childEncoder;
    let v = 0;
    for (let i = 0, len = ops.length; i < len; i += 3) {
        const op = ops[i];
        const a = ops[i + 1];
        const b = ops[i + 2];
        switch (op) {
            case ARRAY_OP.PUSH:
                uvarint(bytes, a * 16 + op, it);
                for (let k = 0; k < a; k++) writeValue(f, type, enc, vals[v++], true);
                break;
            case ARRAY_OP.INSERT:
                uvarint(bytes, a * 16 + op, it);
                uvarint(bytes, b, it);
                for (let k = 0; k < b; k++) writeValue(f, type, enc, vals[v++], true);
                break;
            case ARRAY_OP.SET:
                uvarint(bytes, a * 16 + op, it);
                v++; // previous value: identity mode only
                writeValue(f, type, enc, vals[v++], true);
                break;
            case ARRAY_OP.REMOVE:
                uvarint(bytes, a * 16 + op, it);
                uvarint(bytes, b, it);
                v += b;
                break;
            case ARRAY_OP.REORDER:
                uvarint(bytes, a * 16 + op, it);
                for (let k = 0; k < a; k++) uvarint(bytes, vals[v++], it);
                break;
            case ARRAY_OP.RESTATE:
                uvarint(bytes, b * 2 * 16 + op, it); // positional: rev << 1
                uvarint(bytes, a, it);
                for (let k = 0; k < a; k++) writeValue(f, type, enc, vals[v++], true);
                break;
            default: // REVERSE / CLEAR
                bytes[it.offset++] = op;
                break;
        }
    }
}

function encodeArrayIdentity(f: Frame, log: ArrayLog): void {
    const ops = log.ops;
    const vals = log.vals;
    let v = 0;
    for (let i = 0, len = ops.length; i < len; i += 3) {
        const op = ops[i];
        const a = ops[i + 1];
        const b = ops[i + 2];
        switch (op) {
            case ARRAY_OP.PUSH:
                for (let k = 0; k < a; k++) identityAdd(f, vals[v++]);
                break;
            case ARRAY_OP.INSERT:
                for (let k = 0; k < b; k++) identityAdd(f, vals[v++]);
                break;
            case ARRAY_OP.SET:
                identityDelete(f, vals[v++]);
                identityAdd(f, vals[v++]);
                break;
            case ARRAY_OP.REMOVE:
                for (let k = 0; k < b; k++) identityDelete(f, vals[v++]);
                break;
            case ARRAY_OP.REORDER:
                v += a; // per-view subsets carry no order
                break;
            case ARRAY_OP.RESTATE:
                identityRestate(f, vals, v, a);
                v += a;
                break;
            case ARRAY_OP.CLEAR:
                if (f.lenPos === -1) openChunk(f);
                f.buffer[f.it.offset++] = ARRAY_OP.CLEAR;
                break;
            default: // REVERSE
                break;
        }
    }
}

function elementVisible(f: Frame, value: any): boolean {
    return value !== undefined && f.view!.isChangeTreeVisible(viewTreeOf(value));
}

function identityAdd(f: Frame, value: any): void {
    if (value === undefined) return;
    const tree = viewTreeOf(value)!;
    if (!f.view!.isChangeTreeVisible(tree)) return;
    if (tree._fullSyncGen === f.genA) return; // this view's drain body already carried it
    if (f.lenPos === -1) openChunk(f);
    f.buffer[f.it.offset++] = ARRAY_OP.ADD_REF;
    writeRef(f, f.childType, value, true);
}

function identityDelete(f: Frame, value: any): void {
    if (!elementVisible(f, value)) return;
    if (f.lenPos === -1) openChunk(f);
    uvarint(f.buffer, refIdOf(value) * 16 + ARRAY_OP.DELETE_REF, f.it);
}

/** Identity-form RESTATE from `n` scratch values starting at `from`: the visible refs, merged by the decoder. */
function identityRestate(f: Frame, source: any[], from: number, n: number): void {
    const scratch = f.vals;
    let count = 0;
    for (let k = 0; k < n; k++) {
        const value = source[from + k];
        if (elementVisible(f, value)) scratch[count++] = value;
    }
    noteScratch(f, count, false);
    if (f.lenPos === -1) openChunk(f);
    uvarint(f.buffer, 1 * 16 + ARRAY_OP.RESTATE, f.it); // identity form
    uvarint(f.buffer, count, f.it);
    for (let k = 0; k < count; k++) writeRef(f, f.childType, scratch[k], true);
}

/**
 * Whole-array snapshot as one RESTATE op: positional (authoritative, carries
 * the revision) or identity (the visible refs). Used by full syncs and the
 * `ARRAY_SNAPSHOT` view-drain entry.
 */
export function emitArraySnapshotChunk(f: Frame): void {
    const arr: any[] = f.elements;
    const log = f.tree.rec as ArrayLog;
    if (f.identityMode) {
        identityRestate(f, arr, 0, arr.length);
        return;
    }
    if (f.lenPos === -1) openChunk(f);
    const bytes = f.buffer;
    const it = f.it;
    uvarint(bytes, log.rev * 2 * 16 + ARRAY_OP.RESTATE, it);
    const n = arr.length;
    uvarint(bytes, n, it);
    const type = f.childType;
    const enc = f.childEncoder;
    for (let i = 0; i < n; i++) writeValue(f, type, enc, arr[i], true);
    log.snapRev = log.rev; // a client now holds this revision: entries at or below it are final
}

/** Op byte recorded for Schema field `index` (same storage rule as `ChangeTree._opAt`). */
function schemaOpAt(tree: ChangeTree, index: number): number {
    const ops = tree.ops;
    if (ops !== undefined) return ops[index];
    const shift = (index & 3) << 3;
    return (index < 4)
        ? (tree.opsLow >>> shift) & 0xFF
        : (tree.opsHigh >>> shift) & 0xFF;
}

// ── field emission ───────────────────────────────────────────────────────

/** Live-walk callback (`forEachLiveWithCtx`): every populated field as ADD through the gate. Schemas and keyed collections only. */
export function fullSyncCb(f: Frame, index: number): void {
    if (f.kind === KIND_SCHEMA) {
        if (!schemaFieldPasses(f, index)) return;
        if (f.lenPos === -1) openChunk(f);
        emitSchemaOp(f, index, OPERATION.ADD);
        return;
    }
    if (f.treeIsFiltered !== f.emitFiltered) return;
    if (f.filter !== undefined && !f.filter(f.ref, index, f.view)) return;
    if (f.lenPos === -1) openChunk(f);
    emitKeyedOp(f, index, OPERATION.ADD);
}

/** Emit the live structure of the frame's tree as one chunk (full sync). */
export function emitLiveChunk(f: Frame, forEachLiveWithCtx: (tree: ChangeTree, ctx: Frame, cb: (f: Frame, index: number) => void) => void): void {
    if (f.kind === KIND_ARRAY) {
        if (f.treeIsFiltered !== f.emitFiltered) return;
        if (f.tree.isPatchOnly) return;
        if (f.elements.length === 0 && !f.identityMode) {
            // an empty positional array still needs its revision on a fresh client
            if ((f.tree.rec as ArrayLog).rev === 0) return;
        }
        emitArraySnapshotChunk(f);
    } else {
        forEachLiveWithCtx(f.tree, f, fullSyncCb);
    }
}

function readSchemaValue(f: Frame, index: number): any {
    return f.values[index] ?? f.ref[f.desc.names[index]]; // named fallback: manual fields skip $values
}

function emitSchemaOp(f: Frame, index: number, op: OPERATION): void {
    const buffer = f.buffer;
    const it = f.it;
    const h = (index << 2) | (op >>> 6);
    if (h < 0x80) buffer[it.offset++] = h;
    else uvarint(buffer, h, it);
    if (op === OP_DELETE) return;
    const value = readSchemaValue(f, index);
    // One call site for every primitive writer (megamorphic on a mixed-type
    // schema). Measured alternative — direct `number` / `string` calls behind
    // type-name compares — gained nothing on encode and cost float32 /
    // quantized schemas 4–6 % (bench/realworld-results.md, x4), so the
    // pre-resolved function slot stays.
    const encoderFn = f.desc.encoders[index];
    if (encoderFn !== undefined) encoderFn(buffer, value, it); // primitive fast path stays inline
    else writeSchemaRef(f, index, value, op);
}

function writeSchemaRef(f: Frame, index: number, value: any, op: OPERATION): void {
    writeNonPrimitive(f, f.desc.types[index], value, (op & OP_ADD) === OP_ADD);
}

/**
 * Keyed op: `uvarint(index * 4 + code)`, the map key (ADD-bit ops of a
 * MapSchema only, per its declared key type), then the value. A recorded
 * DELETE_AND_ADD goes out as ADD — the decoder derives the replacement
 * from the slot being occupied.
 */
export function emitKeyedOp(f: Frame, index: number, op: OPERATION): void {
    const buffer = f.buffer;
    const it = f.it;
    uvarint(buffer, index * 4 + KEYED_OP_CODE[op >>> 6], it);
    if (op === OP_DELETE) return;
    const isAdd = (op & OP_ADD) === OP_ADD;
    if (isAdd && f.kind === KIND_MAP) {
        f.keyWriter!(buffer, f.refTarget.keyByIndex.get(index), it);
    }
    writeValue(f, f.childType, f.childEncoder, f.refTarget[$getByIndex](index), isAdd);
}

function writeValue(f: Frame, type: any, encoderFn: ValueWriter | undefined, value: any, allowBody: boolean): void {
    if (encoderFn !== undefined) encoderFn(f.buffer, value, f.it);
    else writeNonPrimitive(f, type, value, allowBody);
}

function writeNonPrimitive(f: Frame, type: any, value: any, allowBody: boolean): void {
    if (typeof type === "string") (encode as any)[type]?.(f.buffer, value, f.it); // runtime-constructed type without a pre-baked writer
    else writeRef(f, type, value, allowBody);
}

/**
 * Ref value: `uvarint(refId*4 + hasBody*2 + hasType) [uvarint typeId] [body]`.
 * `baseType` is the declared field / child type; a typeId rides only when the
 * instance is a registered subclass of it.
 */
function writeRef(f: Frame, baseType: any, value: any, allowBody: boolean): void {
    const child: ChangeTree | undefined = refTreeOf(value);
    const refId = child?.refId;
    if (refId === undefined) {
        throw new Error(`@colyseus/schema: cannot encode a ${value.constructor?.name} without a refId (detached from the state tree?)`);
    }

    let header = refId * 4;
    let typeId: number | undefined;
    if (value.constructor !== baseType && typeof baseType === "function" && baseType[Symbol.metadata] !== undefined) {
        const context = f.context;
        const targetTypeId = context.getTypeId(value.constructor);
        if (targetTypeId === undefined) {
            console.warn(`@colyseus/schema WARNING: Class "${value.constructor.name}" is not registered on TypeRegistry - Please either tag the class with @entity or define a @type() field.`);
        } else if (targetTypeId !== context.getTypeId(baseType)) {
            header += REF_HAS_TYPE;
            typeId = targetTypeId;
        }
    }

    const body = (allowBody && child !== undefined && child.rec !== undefined || allowBody && child !== undefined && child._isSchema) ? canInline(f, child!) : NO_BODY;
    if (body !== NO_BODY) header += REF_HAS_BODY;

    uvarint(f.buffer, header, f.it);
    if (typeId !== undefined) uvarint(f.buffer, typeId, f.it);

    if (body !== NO_BODY) {
        child!._fullSyncGen = (body === BODY_LIVE_A) ? f.genA : f.genB;
        const entry = (body === BODY_LIVE_A) ? f.entryForBody : undefined;
        f.entryForBody = undefined;
        writeBody(f, child!, body === BODY_RECORDER_B, entry);
    }
}

function entryIsAllAdd(entry: Map<number | ChangeTree, OPERATION>): boolean {
    for (const op of entry.values()) {
        if ((op & OPERATION.ADD) !== OPERATION.ADD) return false;
    }
    return true;
}

/**
 * True iff a recorder-sourced body can stand in for the tree's own chunk:
 * the recorder holds nothing but plain ADDs (arrays: pure PUSH). A client
 * that snapshotted the array mid-tick then applies exactly the ops it is
 * missing through the chunk's revision gate; a body would re-state the
 * array positionally and report slot changes instead of the real ops.
 */
function recorderIsPureAdd(f: Frame, tree: ChangeTree): boolean {
    if (tree._isSchema) {
        for (let low = tree.dirtyLow; low !== 0; low &= low - 1) {
            if (schemaOpAt(tree, 31 - Math.clz32(low & -low)) !== OPERATION.ADD) return false;
        }
        for (let high = tree.dirtyHigh; high !== 0; high &= high - 1) {
            if (schemaOpAt(tree, 63 - Math.clz32(high & -high)) !== OPERATION.ADD) return false;
        }
        return true;
    }
    const rec = tree.rec;
    return rec !== undefined && rec.isPureAdd();
}

/**
 * PATCH rule: a fresh instance queued this tick on this side of the filter
 * split, whose recorder qualifies for a body (see `recorderIsPureAdd`). A
 * body decodes as a merge, so this stays correct even for a client that
 * already received the instance through a mid-tick `encodeAll`; anything
 * else falls back to the tree's own chunk.
 */
function patchRule(f: Frame, child: ChangeTree): boolean {
    return child.changesNode !== undefined
        && child.isNew
        && child.has()
        && child._fullSyncGen !== f.genA
        && child._fullSyncGen !== f.genB
        && child.isFiltered === f.emitFiltered
        && (!f.hasView || f.view!.isChangeTreeVisible(child))
        && recorderIsPureAdd(f, child);
}

function canInline(f: Frame, child: ChangeTree): number {
    const stamp = child._fullSyncGen;
    switch (f.mode) {
        case MODE_SNAPSHOT:
            if (stamp === f.genB) return NO_BODY;
            if (f.hasView) {
                if (!child.isFiltered || !f.view!.isChangeTreeVisible(child)) return NO_BODY;
            } else if (child.isFiltered) {
                return NO_BODY;
            }
            return BODY_LIVE_B;

        case MODE_PATCH:
            return patchRule(f, child) ? BODY_RECORDER_B : NO_BODY;

        case MODE_STREAM:
            // broadcast stream element: its full live state rides inline
            return (stamp === f.genB || child.isFiltered !== f.emitFiltered) ? NO_BODY : BODY_LIVE_B;

        default: { // MODE_DRAIN
            if (stamp === f.genA || stamp === f.genB) return NO_BODY;
            const entry = f.view!.changes.get(child.refId);
            if (entry !== undefined && entry.size > 0) {
                // the child's own entry drains normally unless it is a pure
                // visibility bootstrap (all ADDs) we can fold into this body
                if (entryIsAllAdd(entry) && f.view!.isChangeTreeVisible(child)) {
                    f.entryForBody = entry;
                    return BODY_LIVE_A;
                }
                return NO_BODY;
            }
            // no entry (fresh subtree added via the isNew fast path): PATCH rule
            return patchRule(f, child) ? BODY_RECORDER_B : NO_BODY;
        }
    }
}

// ── bodies ───────────────────────────────────────────────────────────────

/**
 * Body sources: SNAPSHOT / STREAM → live structure through the pass filter;
 * PATCH → the child's recorder (Schemas / keyed) or the live array; DRAIN →
 * the child's `view.changes` entry (already tag-filtered by `StateView.add`).
 */
function writeBody(parent: Frame, child: ChangeTree, fromRecorder: boolean, entry?: Map<number | ChangeTree, OPERATION>): void {
    const f = childFrame(parent, child);
    switch (f.kind) {
        case KIND_SCHEMA:
            if (entry !== undefined) writeSchemaBodyEntry(f, entry);
            else if (fromRecorder) writeSchemaBodyRecorder(f);
            else writeSchemaBodyLive(f);
            break;
        case KIND_MAP:
            if (entry !== undefined) writeMapBodyEntry(f, entry);
            else writeMapBody(f);
            break;
        case KIND_ARRAY:
            if (entry !== undefined) writeArrayBodyEntry(f, entry);
            else writeArrayBody(f);
            break;
        default: writeIndexedBody(f); break;
    }
}

/** DRAIN body for a Schema: the entry's field indexes (no per-field re-check, as the drain itself). */
function writeSchemaBodyEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    f.maskLow = 0;
    f.maskHigh = 0;
    for (const key of entry.keys()) {
        if (typeof key !== "number") continue;
        const value = readSchemaValue(f, key);
        if (value === undefined || value === null) continue;
        maskAdd(f, key);
        f.vals[key] = value;
    }
    writeSchemaMaskAndValues(f);
}

/** DRAIN body for a Map: the entry's wire indexes that still hold a value. */
function writeMapBodyEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    const ref = f.refTarget;
    const keys = f.keys;
    const vals = f.vals;
    let n = 0;
    const keyByIndex: RefTable<any> = ref.keyByIndex;
    const strs = f.strs;
    for (const index of entry.keys()) {
        if (typeof index !== "number") continue;
        const value = ref[$getByIndex](index);
        if (value === undefined) continue;
        keys[n] = index;
        strs[n] = keyByIndex.get(index);
        vals[n++] = value;
    }
    writeMapEntries(f, n);
}

/** `count` then `{ index key value }` for the first `n` scratch entries (`keys` hold wire indexes, `strs` the map keys). */
function writeMapEntries(f: Frame, n: number): void {
    const keys = f.keys;
    const strs = f.strs;
    const vals = f.vals;
    const keyWriter = f.keyWriter!;
    noteScratch(f, n, true);
    uvarint(f.buffer, n, f.it);
    for (let i = 0; i < n; i++) {
        uvarint(f.buffer, keys[i], f.it);
        keyWriter(f.buffer, strs[i], f.it);
        writeValue(f, f.childType, f.childEncoder, vals[i], true);
    }
}

function maskAdd(f: Frame, index: number): void {
    if (index < 32) f.maskLow = (f.maskLow | (1 << index)) >>> 0;
    else f.maskHigh = (f.maskHigh | (1 << (index - 32))) >>> 0;
}

function writeSchemaMaskAndValues(f: Frame): void {
    writeMask64(f.buffer, f.maskLow, f.maskHigh, f.it);
    // `vals` is indexed by field here: the mask's highest bit bounds what was written
    noteScratch(f, (f.maskHigh !== 0) ? 64 : 32 - Math.clz32(f.maskLow), false);
    const desc = f.desc;
    let low = f.maskLow;
    while (low !== 0) {
        const bit = low & -low;
        const index = 31 - Math.clz32(bit);
        low ^= bit;
        writeValue(f, desc.types[index], desc.encoders[index], f.vals[index], true);
    }
    let high = f.maskHigh;
    while (high !== 0) {
        const bit = high & -high;
        const index = 31 - Math.clz32(bit) + 32;
        high ^= bit;
        writeValue(f, desc.types[index], desc.encoders[index], f.vals[index], true);
    }
}

/** Live-structure body: every populated, non-skipped field passing this pass's gate (the `forEachLive` rule). */
function writeSchemaBodyLive(f: Frame): void {
    const live = f.desc.liveIndexes;
    f.maskLow = 0;
    f.maskHigh = 0;
    for (let k = 0; k < live.length; k++) {
        const i = live[k];
        const value = readSchemaValue(f, i);
        if (value === undefined || value === null) continue;
        if (!schemaFieldPasses(f, i)) continue;
        maskAdd(f, i);
        f.vals[i] = value;
    }
    writeSchemaMaskAndValues(f);
}

function recorderMaskField(f: Frame, index: number): void {
    if ((schemaOpAt(f.tree, index) & OPERATION.ADD) !== OPERATION.ADD) return;
    const value = readSchemaValue(f, index);
    if (value === undefined || value === null) return;
    if (!schemaFieldPasses(f, index)) return;
    maskAdd(f, index);
    f.vals[index] = value;
}

/** Recorder-sourced body (fresh instance in a patch): ADD-bit fields with a value. */
function writeSchemaBodyRecorder(f: Frame): void {
    f.maskLow = 0;
    f.maskHigh = 0;
    const tree = f.tree;
    for (let low = tree.dirtyLow; low !== 0; low &= low - 1) recorderMaskField(f, 31 - Math.clz32(low & -low));
    for (let high = tree.dirtyHigh; high !== 0; high &= high - 1) recorderMaskField(f, 63 - Math.clz32(high & -high));
    writeSchemaMaskAndValues(f);
}

/**
 * Live map body: every entry, in the map's own (insertion) order. Iterating
 * `$items` costs one `indexByKey` lookup per entry and never meets the
 * mappings of keys removed this tick (they linger in `keyByIndex` until end
 * of tick). Unfiltered maps know the count up front and stream straight to
 * the buffer; filtered maps collect the passing entries first.
 */
function writeMapBody(f: Frame): void {
    const ref = f.refTarget;
    const indexByKey: Map<any, number> = ref.indexByKey;
    const $items: Map<any, any> = ref.$items;
    const filter = f.filter;
    if (filter === undefined) {
        const buffer = f.buffer;
        const it = f.it;
        const keyWriter = f.keyWriter!;
        const type = f.childType;
        const enc = f.childEncoder;
        uvarint(buffer, $items.size, it);
        for (const [key, value] of $items) {
            uvarint(buffer, indexByKey.get(key)!, it);
            keyWriter(buffer, key, it);
            writeValue(f, type, enc, value, true);
        }
        return;
    }
    const keys = f.keys;
    const strs = f.strs;
    const vals = f.vals;
    let n = 0;
    for (const [key, value] of $items) {
        const index = indexByKey.get(key)!;
        if (!filter(f.ref, index, f.view)) continue;
        keys[n] = index;
        strs[n] = key;
        vals[n++] = value;
    }
    writeMapEntries(f, n);
}

function writeIndexedBody(f: Frame): void {
    const $items: Map<number, any> = f.refTarget.$items;
    const filter = f.filter;
    const keys = f.keys;
    const vals = f.vals;
    let n = 0;
    for (const [index, value] of $items) {
        if (filter !== undefined && !filter(f.ref, index, f.view)) continue;
        keys[n] = index;
        vals[n++] = value;
    }
    noteScratch(f, n, false);
    uvarint(f.buffer, n, f.it);
    for (let i = 0; i < n; i++) {
        uvarint(f.buffer, keys[i], f.it);
        writeValue(f, f.childType, f.childEncoder, vals[i], true);
    }
}

/**
 * Array body — the RESTATE payload without the op byte: positional
 * `uvarint(rev*2) uvarint(count) value*` (authoritative), or identity
 * `uvarint(1) uvarint(count) refValue*` (merged by the decoder).
 */
function writeArrayBody(f: Frame): void {
    const arr: any[] = f.elements;
    const log = f.tree.rec as ArrayLog;
    if (f.identityMode) {
        const scratch = f.vals;
        let count = 0;
        for (let i = 0, len = arr.length; i < len; i++) {
            if (elementVisible(f, arr[i])) scratch[count++] = arr[i];
        }
        noteScratch(f, count, false);
        uvarint(f.buffer, 1, f.it);
        uvarint(f.buffer, count, f.it);
        for (let k = 0; k < count; k++) writeRef(f, f.childType, scratch[k], true);
        return;
    }
    uvarint(f.buffer, log.rev * 2, f.it);
    const n = arr.length;
    uvarint(f.buffer, n, f.it);
    const type = f.childType;
    const enc = f.childEncoder;
    for (let i = 0; i < n; i++) writeValue(f, type, enc, arr[i], true);
    log.snapRev = log.rev;
}

/**
 * DRAIN body for an array. `ARRAY_SNAPSHOT` (an explicit `view.add(array)`)
 * means the whole array; otherwise the entry holds the elements this view
 * was just bound to (`view.add(element)`) and only those ride along — the
 * client already holds everything else.
 */
function writeArrayBodyEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    if (!f.identityMode || entry.has(ARRAY_SNAPSHOT)) {
        writeArrayBody(f);
        return;
    }
    const scratch = f.vals;
    let count = 0;
    for (const key of entry.keys()) {
        if (typeof key === "number") continue;
        if (!isEdgeLive(key, f.tree, key._parentIndex ?? -1)) {
            f.view!.changes.delete(key.refId); // removed this patch: its own entry must not ship
            continue;
        }
        if (elementVisible(f, key.ref)) scratch[count++] = key.ref;
    }
    noteScratch(f, count, false);
    uvarint(f.buffer, 1, f.it);
    uvarint(f.buffer, count, f.it);
    for (let k = 0; k < count; k++) writeRef(f, f.childType, scratch[k], true);
}

// ── view drain ───────────────────────────────────────────────────────────

/**
 * Drain one `view.changes` entry into the current frame's chunk (the
 * `encodeView` inner loop). The chunk opens lazily.
 */
export function emitViewEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    const view = f.view!;
    const refTarget = f.refTarget;

    if (f.kind === KIND_ARRAY) {
        for (const [key, op] of entry) {
            if (key === ARRAY_SNAPSHOT) {
                emitArraySnapshotChunk(f);
                continue;
            }
            if (typeof key === "number") continue; // arrays are never addressed by slot
            // identity binding of one element (view.add / view.remove / unsubscribe)
            if (!f.identityMode) continue;
            if (op === OPERATION.DELETE) {
                if (f.lenPos === -1) openChunk(f);
                uvarint(f.buffer, key.refId * 16 + ARRAY_OP.DELETE_REF, f.it);
                continue;
            }
            // same-patch view.add + state removal: the binding is moot and the
            // child's own pending entry must not ship (its refId was never
            // introduced to this client)
            if (!isEdgeLive(key, f.tree, key._parentIndex ?? -1)) {
                view.changes.delete(key.refId);
                continue;
            }
            if (f.lenPos === -1) openChunk(f);
            f.buffer[f.it.offset++] = ARRAY_OP.ADD_REF;
            writeRef(f, f.childType, key.ref, true);
        }
        return;
    }

    for (const [key, op] of entry) {
        if (typeof key !== "number") continue; // identity keys only exist under array parents
        const value = (f.kind === KIND_SCHEMA) ? readSchemaValue(f, key) : refTarget[$getByIndex](key);
        const operation = (value !== undefined && value !== null && op) || OPERATION.DELETE;
        if (f.lenPos === -1) openChunk(f);
        if (f.kind === KIND_SCHEMA) emitSchemaOp(f, key, operation);
        else emitKeyedOp(f, key, operation);
    }
}
