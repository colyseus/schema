import { OPERATION } from "../encoding/spec.js";
import type { Iterator } from "../encoding/decode.js";
import { $changes, $childType, $getByIndex, $refId, $values } from "../types/symbols.js";
import { IS_FILTERED, readInlineOpByte, type ChangeTree } from "../encoder/ChangeTree.js";
import type { StateView } from "../encoder/StateView.js";
import { ARRAY_SNAPSHOT } from "../encoder/StateView.js";
import type { TypeContext } from "../types/TypeContext.js";
import { getV6ClassInfo, type V6ClassInfo } from "./classInfo.js";
import { encode6, endChunk, string6, uvarint, writeMask64 } from "./encoding.js";
import { KIND_ARRAY, KIND_MAP, KIND_SCHEMA, REF_HAS_BODY, REF_HAS_TYPE } from "./spec.js";

export const MODE_SNAPSHOT = 0;
export const MODE_PATCH = 1;
export const MODE_DRAIN = 2;

// module constants keep the hot path off the enum object
const OP_ADD = OPERATION.ADD;
const OP_DELETE = OPERATION.DELETE;

// canInline() results
const NO_BODY = 0;
const BODY_LIVE_A = 1;     // live structure, stamp genA (entry consumed; recorder ops still owed)
const BODY_LIVE_B = 2;     // live structure, stamp genB
const BODY_RECORDER_B = 3; // recorder-sourced, stamp genB

/**
 * Encode context: the pass-level state (buffer, view, stamps — set once per
 * entry point) and the current tree's state on one object, so the per-field
 * hot path reads everything one hop away (v5 `EncodeCtx` shape). Frames come
 * from a depth-indexed pool: depth 0 is the pass itself; an inline body runs
 * on the next frame with the pass fields copied over, so it never clobbers
 * the parent's tree state.
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
    // ── tree ──
    depth: number;
    tree: ChangeTree;
    ref: any;
    refTarget: any;
    /** `ref[$values]` — read once per tree, not per field (undefined on collections). */
    values: any[];
    info: V6ClassInfo;
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
    childEncoder: ((bytes: Uint8Array, value: any, it: Iterator) => void) | undefined;
    /** Position of the chunk's reserved length byte; -1 while no chunk is open. */
    lenPos: number;
    // body scratch: mask bits + the values (and map keys) that passed the gate
    maskLow: number;
    maskHigh: number;
    vals: any[];
    keys: number[];
    strs: string[];
}

const framePool: Frame[] = [];

function frameAt(depth: number): Frame {
    let f = framePool[depth];
    if (f === undefined) {
        f = framePool[depth] = {
            context: undefined!, buffer: undefined!, it: undefined!, capacity: 0, view: undefined, hasView: false,
            emitFiltered: false, mode: MODE_SNAPSHOT, genA: 0, genB: 0,
            depth, tree: undefined!, ref: undefined, refTarget: undefined, values: undefined!, info: undefined!, kind: 0,
            treeIsFiltered: false, emitMask: 0, filter: undefined, childType: undefined, childEncoder: undefined,
            lenPos: -1, maskLow: 0, maskHigh: 0, vals: [], keys: [], strs: [],
        };
    }
    return f;
}

/** The pass frame (depth 0). The entry point fills the pass fields before use. */
export function passFrame(): Frame {
    return frameAt(0);
}

/** Drop the tree references every frame of the finished pass still holds, so a disposed state can be collected. */
export function releaseFrames(): void {
    for (let i = 0; i < framePool.length; i++) {
        const f = framePool[i];
        if (f.tree === undefined) break;
        f.tree = undefined!;
        f.ref = undefined;
        f.refTarget = undefined;
        f.values = undefined!;
        f.vals.length = 0;
        f.strs.length = 0;
    }
}

/** Load `tree` into `f` (tree fields only). Straight-line on purpose: it must inline into the patch loop. */
export function enterFrame(f: Frame, tree: ChangeTree): void {
    const desc = tree.encDescriptor;
    const refTarget = tree.refTarget as any;
    let info = desc.v6 as V6ClassInfo | undefined;
    if (info === undefined) info = getV6ClassInfo(desc, refTarget.constructor);
    const treeIsFiltered = (tree.flags & IS_FILTERED) !== 0;
    const childType = refTarget[$childType]; // per-instance child type; undefined on Schema trees
    f.tree = tree;
    f.ref = tree.ref;
    f.refTarget = refTarget;
    f.values = refTarget[$values];
    f.info = info;
    f.kind = info.kind;
    f.treeIsFiltered = treeIsFiltered;
    const filterBits = treeIsFiltered ? -1 : info.filterBitmask;
    f.emitMask = f.emitFiltered ? filterBits : ~filterBits;
    f.filter = desc.filter;
    f.childType = childType;
    f.childEncoder = (typeof childType === "string") ? encode6[childType] : undefined;
    f.lenPos = -1;
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
function openChunk(f: Frame): void {
    const refId: number = f.ref[$refId]; // read only when a chunk actually opens
    if (refId >= 0x4000) { openChunkLong(f, refId); return; }
    const it = f.it;
    const buffer = f.buffer;
    let o = it.offset;
    if (refId < 0x80) {
        buffer[o++] = refId;
    } else {
        buffer[o++] = (refId & 0x7f) | 0x80;
        buffer[o++] = refId >>> 7;
    }
    f.lenPos = o;
    it.offset = o + 1;
}

function openChunkLong(f: Frame, refId: number): void {
    const it = f.it;
    uvarint(f.buffer, refId, it);
    f.lenPos = it.offset++;
}

export function closeChunk(f: Frame): void {
    const lenPos = f.lenPos;
    if (lenPos === -1) return;
    f.lenPos = -1;
    const len = f.it.offset - lenPos - 1;
    if (len < 0x80) f.buffer[lenPos] = len;
    else closeChunkLong(f, lenPos);
}

function closeChunkLong(f: Frame, lenPos: number): void {
    endChunk(f.buffer, lenPos, f.it, f.capacity);
}

/** Schema field gate (v5 `encodeChangeCb` rule): filter class of the field, then the class filter. */
function schemaFieldPasses(f: Frame, index: number): boolean {
    if (index < 32 ? (f.emitMask & (1 << index)) === 0 : wideFieldFiltered(f, index) !== f.emitFiltered) return false;
    return f.filter === undefined || classFilterPasses(f, index);
}

/** Per-instance `[$filter]` of `@view` classes; out of line so it costs inlining budget only where such classes exist. */
function classFilterPasses(f: Frame, index: number): boolean {
    return f.filter!(f.ref, index, f.view);
}

/** Fields past the bitmask (index ≥ 32); out of line so it costs inlining budget only where such classes exist. */
function wideFieldFiltered(f: Frame, index: number): boolean {
    return f.treeIsFiltered || f.info.tags[index] !== undefined;
}

/** Field-level gate shared by generic emission and body building. */
function fieldPasses(f: Frame, index: number): boolean {
    if (f.kind === KIND_SCHEMA) return schemaFieldPasses(f, index);
    if (f.treeIsFiltered !== f.emitFiltered) return false;
    return f.filter === undefined || f.filter(f.ref, index, f.view);
}

// ── recorder walk ────────────────────────────────────────────────────────

/**
 * Emit every pending op of the frame's tree (patch / per-view tick chunk).
 * Walks the recorder here instead of through `tree.forEachWithCtx`: that
 * callback site is shared by every recorder consumer in the process and goes
 * megamorphic, so its callback never inlines. Here the per-field emitter is
 * a direct call.
 */
export function encodeTreeOps(f: Frame): void {
    if (f.kind === KIND_SCHEMA) encodeSchemaOps(f);
    else encodeCollectionOps(f);
}

export function encodeSchemaOps(f: Frame): void {
    const tree = f.tree;
    const ops = tree.ops;
    if (ops !== undefined) { encodeSchemaOpsArray(f, tree, ops); return; }
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

/** Wide Schemas (> 8 fields) keep their op bytes in `tree.ops`; out of line so it only inlines where it runs. */
function encodeSchemaOpsArray(f: Frame, tree: ChangeTree, ops: Uint8Array): void {
    let low = tree.dirtyLow;
    while (low !== 0) {
        const bit = low & -low;
        const index = 31 - Math.clz32(bit);
        low ^= bit;
        schemaFieldOp(f, index, ops[index]);
    }
    let high = tree.dirtyHigh;
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
    emitSchemaOp6(f, index, op);
}

export function encodeCollectionOps(f: Frame): void {
    // every collection op carries the tree's filter class (pure ops included)
    if (f.treeIsFiltered !== f.emitFiltered) return;
    const tree = f.tree;
    const dirty = tree.collDirty!;
    const pure = tree.collPureOps;
    if (pure !== undefined && pure.length > 0) {
        let pureIdx = 0, i = 0;
        for (const [index, op] of dirty) {
            while (pureIdx < pure.length && pure[pureIdx][0] <= i) pureOp(f, pure[pureIdx++][1]);
            collectionOp(f, index, op);
            i++;
        }
        while (pureIdx < pure.length) pureOp(f, pure[pureIdx++][1]);
    } else {
        for (const [index, op] of dirty) collectionOp(f, index, op);
    }
}

function pureOp(f: Frame, op: OPERATION): void {
    if (f.lenPos === -1) openChunk(f);
    f.buffer[f.it.offset++] = op & 255;
}

function collectionOp(f: Frame, index: number, op: OPERATION): void {
    if (op === undefined) return;
    if (f.filter !== undefined && !f.filter(f.ref, index, f.view)) return;
    if (f.lenPos === -1) openChunk(f);
    emitCollectionOp(f, index, op);
}

/** Op byte recorded for Schema field `index` (same storage rule as `ChangeTree._opAt`). */
function schemaOpAt(tree: ChangeTree, index: number): number {
    const ops = tree.ops;
    return ops !== undefined ? ops[index] : readInlineOpByte(tree.opsLow, tree.opsHigh, index);
}

// ── field emission ───────────────────────────────────────────────────────

/** Live-walk callback (`forEachLiveWithCtx`): every populated field as ADD through the gate. */
export function fullSyncCb6(f: Frame, index: number): void {
    if (!fieldPasses(f, index)) return;
    if (f.lenPos === -1) openChunk(f);
    emitField(f, index, OPERATION.ADD);
}

function emitField(f: Frame, index: number, op: OPERATION): void {
    if (f.kind === KIND_SCHEMA) emitSchemaOp6(f, index, op);
    else emitCollectionOp(f, index, op);
}

function emitCollectionOp(f: Frame, index: number, op: OPERATION): void {
    switch (f.kind) {
        case KIND_MAP: emitMapOp6(f, index, op); break;
        case KIND_ARRAY: emitArrayOp6(f, index, op); break;
        default: emitIndexedOp6(f, index, op); break;
    }
}

function readSchemaValue(f: Frame, index: number): any {
    return f.values[index] ?? f.ref[f.info.names[index]]; // named fallback: manual fields skip $values
}

function emitSchemaOp6(f: Frame, index: number, op: OPERATION): void {
    const buffer = f.buffer;
    const it = f.it;
    const h = (index << 2) | (op >>> 6);
    if (h < 0x80) buffer[it.offset++] = h;
    else uvarint(buffer, h, it);
    if (op === OP_DELETE) return;
    const value = readSchemaValue(f, index);
    const encoderFn = f.info.encoders[index];
    if (encoderFn !== undefined) encoderFn(buffer, value, it); // primitive fast path stays inline
    else writeSchemaRef(f, index, value, op);
}

function writeSchemaRef(f: Frame, index: number, value: any, op: OPERATION): void {
    writeNonPrimitive(f, f.info.types[index], value, (op & OP_ADD) === OP_ADD);
}

function emitMapOp6(f: Frame, index: number, op: OPERATION): void {
    const buffer = f.buffer;
    const it = f.it;
    buffer[it.offset++] = op & 255;
    uvarint(buffer, index, it);
    if (op === OPERATION.DELETE) return;
    if ((op & OPERATION.ADD) === OPERATION.ADD) {
        string6(buffer, f.refTarget.journal.keyByIndex.get(index), it);
    }
    writeValue(f, f.childType, f.childEncoder, f.refTarget[$getByIndex](index), (op & OPERATION.ADD) === OPERATION.ADD);
}

function emitIndexedOp6(f: Frame, index: number, op: OPERATION): void {
    const buffer = f.buffer;
    const it = f.it;
    buffer[it.offset++] = op & 255;
    uvarint(buffer, index, it);
    if (op === OPERATION.DELETE) return;
    writeValue(f, f.childType, f.childEncoder, f.refTarget[$getByIndex](index), (op & OPERATION.ADD) === OPERATION.ADD);
}

/** Port of v5 `encodeArray`: identity ops for filtered Schema-child arrays, positional otherwise. */
function emitArrayOp6(f: Frame, slot: number, op: OPERATION): void {
    const ref = f.refTarget;
    const type = f.childType;
    const isSchemaChild = typeof type !== "string";
    const bytes = f.buffer;
    const it = f.it;

    if (f.hasView && f.treeIsFiltered && isSchemaChild) {
        const item = ref.tmpItems[slot];
        if (!item) return; // e.g. after clear()
        if (op === OPERATION.DELETE) {
            bytes[it.offset++] = OPERATION.DELETE_BY_REFID;
            uvarint(bytes, item[$refId], it);
        } else if ((op & OPERATION.ADD) === OPERATION.ADD) {
            bytes[it.offset++] = OPERATION.ADD_BY_REFID;
            writeRef(f, type, item, true);
        }
        // MOVE / DELETE_AND_MOVE: per-view subsets carry no order — nothing to emit
        return;
    }

    if (op === OPERATION.DELETE && isSchemaChild) {
        // identity delete: idempotent for clients that never held the item
        const item = ref.tmpItems[slot];
        if (!item) return;
        bytes[it.offset++] = OPERATION.DELETE_BY_REFID;
        uvarint(bytes, item[$refId], it);
        return;
    }

    bytes[it.offset++] = op & 255;
    uvarint(bytes, slot, it);
    if (op === OPERATION.DELETE) return;
    const value = ref[$getByIndex](slot, f.mode === MODE_SNAPSHOT);
    writeValue(f, type, f.childEncoder, value, (op & OPERATION.ADD) === OPERATION.ADD);
}

function writeValue(
    f: Frame,
    type: any,
    encoderFn: ((bytes: Uint8Array, value: any, it: Iterator) => void) | undefined,
    value: any,
    allowBody: boolean,
): void {
    if (encoderFn !== undefined) encoderFn(f.buffer, value, f.it);
    else writeNonPrimitive(f, type, value, allowBody);
}

function writeNonPrimitive(f: Frame, type: any, value: any, allowBody: boolean): void {
    if (typeof type === "string") encode6[type]?.(f.buffer, value, f.it); // runtime-constructed type without a pre-baked writer
    else writeRef(f, type, value, allowBody);
}

/**
 * Ref value: `uvarint(refId*4 + hasBody*2 + hasType) [uvarint typeId] [body]`.
 * `baseType` is the declared field / child type; a typeId rides only when the
 * instance is a registered subclass of it.
 */
function writeRef(f: Frame, baseType: any, value: any, allowBody: boolean): void {
    const child: ChangeTree | undefined = value[$changes];
    const refId: number | undefined = value[$refId];
    if (refId === undefined) {
        throw new Error(`@colyseus/schema v6: cannot encode a ${value.constructor?.name} without a refId (detached from the state tree?)`);
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

    const body = (allowBody && child !== undefined) ? canInline(f, child) : NO_BODY;
    if (body !== NO_BODY) header += REF_HAS_BODY;

    uvarint(f.buffer, header, f.it);
    if (typeId !== undefined) uvarint(f.buffer, typeId, f.it);

    if (body !== NO_BODY) {
        child!._fullSyncGen = (body === BODY_LIVE_A) ? f.genA : f.genB;
        const entry = (body === BODY_LIVE_A) ? _entryForBody : undefined;
        _entryForBody = undefined;
        writeBody(f, child!, body === BODY_RECORDER_B, entry);
    }
}

/** Entry a DRAIN body is sourced from (set by `canInline`, consumed by `writeBody`). */
let _entryForBody: Map<number | ChangeTree, OPERATION> | undefined;

function entryIsAllAdd(entry: Map<number | ChangeTree, OPERATION>): boolean {
    for (const op of entry.values()) {
        if ((op & OPERATION.ADD) !== OPERATION.ADD) return false;
    }
    return true;
}

/** True iff every pending op on the tree is a plain ADD (no DELETE / DELETE_AND_ADD / REPLACE / MOVE / pure ops). */
function recorderIsPureAdd(tree: ChangeTree): boolean {
    if (tree._isSchema) {
        for (let low = tree.dirtyLow; low !== 0; low &= low - 1) {
            if (schemaOpAt(tree, 31 - Math.clz32(low & -low)) !== OPERATION.ADD) return false;
        }
        for (let high = tree.dirtyHigh; high !== 0; high &= high - 1) {
            if (schemaOpAt(tree, 63 - Math.clz32(high & -high)) !== OPERATION.ADD) return false;
        }
        return true;
    }
    const pure = tree.collPureOps;
    if (pure !== undefined && pure.length > 0) return false;
    for (const op of tree.collDirty!.values()) {
        if (op !== OPERATION.ADD) return false;
    }
    return true;
}

/**
 * PATCH rule: a fresh instance queued this tick on this side of the filter
 * split, whose recorder holds nothing but plain ADDs. A body decodes as a
 * merge, so this stays correct even for a client that already received the
 * instance through a mid-tick `encodeAll`; any DELETE / DELETE_AND_ADD /
 * REPLACE / MOVE in the recorder falls back to the tree's own chunk, exactly
 * as v5 emits it.
 */
function patchRule(f: Frame, child: ChangeTree): boolean {
    return child.changesNode !== undefined
        && child.isNew
        && child.has()
        && child._fullSyncGen !== f.genA
        && child._fullSyncGen !== f.genB
        && child.isFiltered === f.emitFiltered
        && (!f.hasView || f.view!.isChangeTreeVisible(child))
        && recorderIsPureAdd(child);
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

        default: { // MODE_DRAIN
            if (stamp === f.genA || stamp === f.genB) return NO_BODY;
            const entry = f.view!.changes.get(child.ref[$refId]);
            if (entry !== undefined && entry.size > 0) {
                // the child's own entry drains normally unless it is a pure
                // visibility bootstrap (all ADDs) we can fold into this body
                if (entryIsAllAdd(entry) && f.view!.isChangeTreeVisible(child)) {
                    _entryForBody = entry;
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
 * Body sources: SNAPSHOT → live structure through the pass filter; PATCH →
 * the child's recorder; DRAIN → the child's `view.changes` entry (already
 * tag-filtered by `StateView.add`, exactly what v5 drains for it).
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
            if (entry !== undefined && !entry.has(ARRAY_SNAPSHOT)) writeArrayBodyEntry(f, entry);
            else writeArrayBody(f);
            break;
        default: writeIndexedBody(f); break;
    }
}

/** DRAIN body for a Schema: the entry's field indexes (no per-field re-check, as v5's drain). */
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
    const keyByIndex: Map<number, string> = ref.journal.keyByIndex;
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

/** `count` then `{ index key value }` for the first `n` scratch entries (`keys` hold wire indexes, `strs` the string keys). */
function writeMapEntries(f: Frame, n: number): void {
    const keys = f.keys;
    const strs = f.strs;
    const vals = f.vals;
    uvarint(f.buffer, n, f.it);
    for (let i = 0; i < n; i++) {
        uvarint(f.buffer, keys[i], f.it);
        string6(f.buffer, strs[i], f.it);
        writeValue(f, f.childType, f.childEncoder, vals[i], true);
    }
}

/** DRAIN body for an Array without a whole-array snapshot: only the bound slots. */
function writeArrayBodyEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    const ref = f.refTarget;
    const vals = f.vals;
    let n = 0;
    for (const key of entry.keys()) {
        const slot = (typeof key === "number") ? key : key.indexInParent(f.ref);
        if (slot === undefined) continue;
        if (ref.tmpItems[slot] === undefined || ref.deletedIndexes[slot] === true) continue;
        vals[n++] = ref.tmpItems[slot];
    }
    writeArrayValues(f, n);
}

/** `count` then the first `n` scratch values. */
function writeArrayValues(f: Frame, n: number): void {
    const vals = f.vals;
    uvarint(f.buffer, n, f.it);
    for (let i = 0; i < n; i++) writeValue(f, f.childType, f.childEncoder, vals[i], true);
}

function maskAdd(f: Frame, index: number): void {
    if (index < 32) f.maskLow = (f.maskLow | (1 << index)) >>> 0;
    else f.maskHigh = (f.maskHigh | (1 << (index - 32))) >>> 0;
}

function writeSchemaMaskAndValues(f: Frame): void {
    writeMask64(f.buffer, f.maskLow, f.maskHigh, f.it);
    const info = f.info;
    let low = f.maskLow;
    while (low !== 0) {
        const bit = low & -low;
        const index = 31 - Math.clz32(bit);
        low ^= bit;
        writeValue(f, info.types[index], info.encoders[index], f.vals[index], true);
    }
    let high = f.maskHigh;
    while (high !== 0) {
        const bit = high & -high;
        const index = 31 - Math.clz32(bit) + 32;
        high ^= bit;
        writeValue(f, info.types[index], info.encoders[index], f.vals[index], true);
    }
}

/** Live-structure body: every populated, non-skipped field passing this pass's gate (v5 `forEachLive` rule). */
function writeSchemaBodyLive(f: Frame): void {
    const live = f.info.liveIndexes;
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

function writeMapBody(f: Frame): void {
    const ref = f.refTarget;
    const keyByIndex: Map<number, string> = ref.journal.keyByIndex;
    const $items: Map<string, any> = ref.$items;
    const filter = f.filter;
    const keys = f.keys;
    const strs = f.strs;
    const vals = f.vals;
    let n = 0;
    for (const [index, key] of keyByIndex) {
        const value = $items.get(key);
        if (value === undefined) continue; // journal still holds keys deleted this tick
        if (filter !== undefined && !filter(f.ref, index, f.view)) continue;
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
    uvarint(f.buffer, n, f.it);
    for (let i = 0; i < n; i++) {
        uvarint(f.buffer, keys[i], f.it);
        writeValue(f, f.childType, f.childEncoder, vals[i], true);
    }
}

/**
 * Array body: positional list of live elements. Snapshot reads the committed
 * `items`; patch/drain read the staged wire slots (`tmpItems` minus
 * `deletedIndexes`), same split as v5's `$getByIndex(index, isEncodeAll)`.
 */
function writeArrayBody(f: Frame): void {
    const ref = f.refTarget;
    const filter = f.filter;
    const snapshot = f.mode === MODE_SNAPSHOT;
    const items: any[] = snapshot ? ref.items : ref.tmpItems;
    const deleted: boolean[] | undefined = snapshot ? undefined : ref.deletedIndexes;
    const vals = f.vals;
    let n = 0;
    for (let i = 0, len = items.length; i < len; i++) {
        const value = items[i];
        if (value === undefined) continue;
        if (deleted !== undefined && deleted[i] === true) continue;
        if (filter !== undefined && !filter(f.ref, i, f.view)) continue;
        vals[n++] = value;
    }
    writeArrayValues(f, n);
}

// ── view drain ───────────────────────────────────────────────────────────

/**
 * Drain one `view.changes` entry into the current frame's chunk (v5
 * `encodeView` inner loop). The chunk opens lazily.
 */
export function emitViewEntry(f: Frame, entry: Map<number | ChangeTree, OPERATION>): void {
    const view = f.view!;
    const refTarget = f.refTarget;
    for (const [key, op] of entry) {
        if (key === ARRAY_SNAPSHOT) {
            // whole-array snapshot at drain time (slots survive same-tick reindex)
            const tmpItems: any[] = refTarget.tmpItems;
            const deletedIndexes: boolean[] = refTarget.deletedIndexes;
            for (let slot = 0; slot < tmpItems.length; slot++) {
                if (tmpItems[slot] === undefined || deletedIndexes[slot] === true) continue;
                if (f.lenPos === -1) openChunk(f);
                emitArrayOp6(f, slot, OPERATION.ADD);
            }
            continue;
        }
        let index: number;
        if (typeof key === "number") {
            index = key;
        } else {
            const resolved = key.indexInParent(f.ref);
            if (resolved === undefined) continue; // detached and re-parented elsewhere
            index = resolved;
            // same-patch add + state removal: the binding is moot and the
            // child's own pending entry must not ship (v5 rule)
            if (op === OPERATION.ADD && f.tree.getChange(index) === OPERATION.DELETE) {
                view.changes.delete(key.ref[$refId]);
                continue;
            }
        }
        const value = refTarget[$getByIndex](index);
        const operation = (value !== undefined && op) || OPERATION.DELETE;
        if (f.lenPos === -1) openChunk(f);
        emitField(f, index, operation);
    }
}
