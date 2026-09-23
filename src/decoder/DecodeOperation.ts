import { ARRAY_OP, KEYED_OP, OPERATION, REF_HAS_BODY, REF_HAS_TYPE, CollectionKind } from "../encoding/spec.js";
import { treeOfDecoded, decodedRefIdOf as refIdOfValue } from "../encoder/ChangeTree.js";
import type { Iterator } from "../encoding/decode.js";
import { decode } from "../encoding/decode.js";
import { readString, readUvarint } from "../encoding/varint.js";
import { Schema } from "../Schema.js";
import type { IRef } from "../encoder/ChangeTree.js";
import { $childType, $deleteByIndex, $keyType, $rev, $values } from "../types/symbols.js";
import { getType } from "../types/registry.js";
import { decodeQuantized, isQuantizedType } from "../types/quantize.js";
import { resyncMarkPresent, resyncRecordVisit, resyncTouchEntry } from "./Resync.js";
import type { Decoder } from "./Decoder.js";
import { getDecodeInfo, type DecodeInfo } from "./DecodeInfo.js";

export interface DataChange<T = any, F = string> {
    ref: IRef,
    refId: number,
    op: OPERATION,
    /** Set for Schema field changes; omitted for collection item changes (which carry a `dynamicIndex` instead). */
    field?: F;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

/** Thrown on a definition mismatch inside a chunk; the chunk loop skips to the chunk end. */
export class ChunkMismatch extends Error {}

type Reader = (bytes: Uint8Array, it: Iterator) => any;

import { arrCopy, arrIndexOf, arrInsertOne, arrRemove, arrReverse } from "../types/custom/arrayOps.js";

/** Reader for a collection's child type: pre-resolved once per chunk / body, `undefined` for ref children. */
function childReaderOf(type: any): Reader | undefined {
    if (typeof type === "string") return (decode as any)[type];
    if (isQuantizedType(type)) return (bytes, it) => decodeQuantized(type.quantized, bytes, it);
    return undefined;
}

/**
 * Reader for a MapSchema's declared numeric key type; `undefined` for string
 * (or undeclared) keys, which the callers read with a direct `readString`
 * call so the common path keeps its inlined string read.
 */
function keyReaderOf(keyType: string | undefined): Reader | undefined {
    return (keyType === undefined || keyType === "string") ? undefined : (decode as any)[keyType];
}

export const REF_SCHEMA = 0, REF_ARRAY = 1, REF_MAP = 2, REF_KEYED = 3;

/**
 * Per-ref decode record, cached on the ref's `$changes` tree
 * (`UntrackedChangeTree.decodeInfo`). One shape for every kind so the loads that
 * follow are monomorphic; a chunk then costs one megamorphic load
 * (`ref[$changes]`) instead of `ref.constructor` + `COLLECTION_KIND` +
 * `ctor[$decodeInfo]` + `ref[$values]` / `ref[$childType]`, and quantized
 * child readers are resolved once per ref instead of once per chunk.
 */
export interface RefInfo {
    kind: number;
    info: DecodeInfo | undefined;      // Schema
    values: any[] | undefined;         // Schema: the instance's `$values` backing array
    childType: any;                    // collections
    reader: Reader | undefined;        // collections: child reader (`undefined` for ref children)
    keyReader: Reader | undefined;     // MapSchema numeric key reader (`undefined` = string keys)
}

function buildRefInfo(ref: any): RefInfo {
    const ctor = ref.constructor;
    const collectionKind = ctor.COLLECTION_KIND;
    if (collectionKind === undefined) {
        return { kind: REF_SCHEMA, info: getDecodeInfo(ctor), values: ref[$values], childType: undefined, reader: undefined, keyReader: undefined };
    }
    const childType = ref[$childType];
    const kind = (collectionKind === CollectionKind.Array) ? REF_ARRAY
        : (collectionKind === CollectionKind.Map) ? REF_MAP : REF_KEYED;
    return {
        kind, info: undefined, values: undefined, childType,
        reader: childReaderOf(childType),
        keyReader: (kind === REF_MAP) ? keyReaderOf(ref[$keyType]) : undefined,
    };
}

/** Tiny on purpose (it must inline into the chunk loop): every ref the decoder meets carries a `$changes` tree. */
export function refInfoOf(ref: any): RefInfo {
    const ri: RefInfo | undefined = (treeOfDecoded(ref) as any).decodeInfo;
    return (ri !== undefined) ? ri : refInfoSlow(ref);
}

function refInfoSlow(ref: any): RefInfo {
    const ri = buildRefInfo(ref);
    // Decoder-built instances carry an `UntrackedChangeTree`, which declares
    // the slot. A tracked `ChangeTree` does not (it is server-side state and
    // pays for no decoder field); the rare tracked instance a Decoder decodes
    // into — the root handed to `new Decoder(state)`, a test decoding into a
    // live server instance — gets the record as a lazily added property: one
    // map transition on that tree only, no side table to keep alive.
    (treeOfDecoded(ref) as any).decodeInfo = ri;
    return ri;
}

/** Collection type object (`{ map: X, key?: … }`): the kind is always its first own key. */
function setCollectionTypes(value: any, kind: string, type: any, childType: any): void {
    value[$childType] = childType;
    if (kind === "map") value[$keyType] = type.key ?? "string";
}

/**
 * Ref header of the value just read by `readSlotValue` (0 for primitives).
 * Module-level so the per-slot path returns one primitive and allocates
 * nothing; callers consume it immediately, before any nested read.
 */
let lastHeader = 0;

function readSlotValue(d: Decoder, reader: Reader | undefined, op: OPERATION, previousValue: any, type: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): any {
    if (reader !== undefined) {
        lastHeader = 0;
        return reader(bytes, it);
    }
    const header = readUvarint(bytes, it);
    lastHeader = header;
    return resolveRef(d, header, op, previousValue, type, bytes, it, allChanges);
}

/** `refId` from a ref header; refIds stay far below 2^29 so the shift is exact. */
function refIdOf(header: number): number {
    return header < 0x80000000 ? header >>> 2 : Math.floor(header / 4);
}

/**
 * Resolve a ref value header into an instance, applying the refcount rules:
 * increment on an ADD-bit op when the slot's value changed (or on a
 * DELETE_AND_ADD self-reassign). A collection already known by refId is
 * merged into, never replaced. Does NOT decode the body.
 */
function resolveRef(
    d: Decoder,
    header: number,
    op: OPERATION,
    previousValue: any,
    type: any,
    bytes: Uint8Array,
    it: Iterator,
    allChanges: DataChange[] | null,
): any {
    const $root = d.root;
    const refId = refIdOf(header);
    const typeId = (header & REF_HAS_TYPE) ? readUvarint(bytes, it) : undefined;

    if (Schema.is(type)) {
        let value = $root.getRef(refId);
        if ((op & OPERATION.ADD) === OPERATION.ADD) {
            if (value === undefined) {
                const childType = (typeId !== undefined ? d.context.get(typeId) : undefined) ?? type;
                value = d.createInstanceOfType(childType);
            }
            $root.addRef(refId, value, (
                value !== previousValue ||
                (op === OPERATION.DELETE_AND_ADD && value === previousValue)
            ));
        }
        return value;
    }

    // collection: `{ map: X }` / `{ array: X }` … — one key, read without allocating
    let kind: string = "";
    let childType: any;
    for (const k in type) { kind = k; childType = type[k]; break; }
    if (d.resyncVisited !== null) resyncMarkPresent(d, refId);

    let value: any = $root.getRef(refId);
    if (value === undefined) {
        value = (getType(kind).constructor as any).initializeForDecoder();
        setCollectionTypes(value, kind, type, childType);
    }

    if (previousValue) {
        let previousRefId = refIdOfValue(previousValue);
        if (previousRefId !== undefined && refId !== previousRefId) {
            // replaced by a different collection instance: release it (unless a
            // DELETE bit already did), enqueue onRemove for its entries, and
            // leave its children to GC (a shared child must not double-decrement)
            if ((op & OPERATION.DELETE) !== OPERATION.DELETE) {
                $root.removeRef(previousRefId);
            }
            const entries: IterableIterator<[any, any]> = previousValue.entries();
            let iter: IteratorResult<[any, any]>;
            while ((iter = entries.next()) && !iter.done) {
                const [key, v] = iter.value;
                if (typeof v === "object") previousRefId = refIdOfValue(v);
                allChanges?.push({ ref: previousValue, refId: previousRefId, op: OPERATION.DELETE, field: key, value: undefined, previousValue: v });
            }
        }
    }

    $root.addRef(refId, value, (
        value !== previousValue ||
        (op === OPERATION.DELETE_AND_ADD && value === previousValue)
    ));
    return value;
}

/**
 * Consume a ref value the client already holds (an array op its revision
 * covers): no refcount change, but an inline body still merges.
 */
function consumeRefValue(d: Decoder, header: number, type: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): void {
    const $root = d.root;
    const refId = refIdOf(header);
    const typeId = (header & REF_HAS_TYPE) ? readUvarint(bytes, it) : undefined;
    let value = $root.getRef(refId);
    if (value === undefined) {
        // not held after all (should not happen): create it without a count
        if (Schema.is(type)) {
            value = d.createInstanceOfType((typeId !== undefined ? d.context.get(typeId) : undefined) ?? type);
        } else {
            let kind = "", childType: any;
            for (const k in type) { kind = k; childType = type[k]; break; }
            value = (getType(kind).constructor as any).initializeForDecoder();
            setCollectionTypes(value, kind, type, childType);
        }
        $root.addRef(refId, value, false);
    }
    if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
}

/** Read a value the client already holds: primitives are discarded, refs consumed. */
function skipValue(d: Decoder, reader: Reader | undefined, type: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): void {
    if (reader !== undefined) { reader(bytes, it); return; }
    consumeRefValue(d, readUvarint(bytes, it), type, bytes, it, allChanges);
}

/** DELETE-bit prologue shared by the Schema / keyed paths: release the previous ref, clear the slot unless it is being re-set. */
function releaseSlot(d: Decoder, ref: any, index: number, op: OPERATION, previousValue: any): void {
    const previousRefId = refIdOfValue(previousValue);
    if (previousRefId !== undefined) d.root.removeRef(previousRefId);
    if (op !== OPERATION.DELETE_AND_ADD) ref[$deleteByIndex](index);
}

function fieldAt(info: DecodeInfo, index: number, ref: any): any {
    const field = info.fields[index];
    if (field === undefined) {
        console.warn("@colyseus/schema: field not defined at", { index, ref: ref.constructor.name });
        throw new ChunkMismatch();
    }
    return field;
}

/** Decode an inline body into `value` (kind-dispatched). Restores `currentRefId` afterwards. */
function decodeBody(d: Decoder, value: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): void {
    const saved = d.currentRefId;
    const tree: any = treeOfDecoded(value); // one load serves both the refId and the decode record
    const refId: number = tree.refId;
    d.currentRefId = refId;
    const ri: RefInfo = (tree.decodeInfo !== undefined) ? tree.decodeInfo : refInfoOf(value);
    const kind = ri.kind;
    if (kind === REF_SCHEMA) decodeSchemaBody(d, bytes, it, value, refId, allChanges, ri);
    else if (kind === REF_ARRAY) decodeArrayBody(d, bytes, it, value, refId, allChanges, ri);
    else decodeKeyValueBody(d, bytes, it, value, refId, allChanges, kind === REF_MAP, ri);
    d.currentRefId = saved;
}

// ── Schema ──────────────────────────────────────────────────────────────

function decodeSchemaSlot(
    d: Decoder, bytes: Uint8Array, it: Iterator, ref: any, refId: number,
    info: DecodeInfo, values: any[] | undefined, index: number, field: any, op: OPERATION, allChanges: DataChange[] | null,
): void {
    // Primitive slot behind the generated accessor: read/write the backing
    // array directly. Equivalent to `ref[name]` (getter = `values[index]`;
    // setter = `values[index] = v` plus change tracking, a no-op on
    // decoder-built trees) without the megamorphic dynamic-name access.
    if (values !== undefined && info.direct[index] === true) {
        const previousValue = values[index];
        let value: any;
        if (op === OPERATION.DELETE) {
            value = undefined;
            values[index] = undefined;
        } else {
            value = info.readers[index]!(bytes, it);
            if (value !== null && value !== undefined) values[index] = value;
        }
        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op, field: field.name, value, previousValue });
        }
        return;
    }

    const isDeprecated = field.deprecated === true;
    const previousValue = isDeprecated ? undefined : ref[field.name];
    let value: any;

    if ((op & OPERATION.DELETE) === OPERATION.DELETE) {
        releaseSlot(d, ref, index, op, previousValue);
        value = undefined;
    }

    let header = 0;
    if (op !== OPERATION.DELETE) {
        value = readSlotValue(d, info.readers[index], op, previousValue, field.type, bytes, it, allChanges);
        header = lastHeader;
    }

    if (isDeprecated) {
        // bytes consumed, nothing written or reported
        if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
        return;
    }

    if (value !== null && value !== undefined) {
        ref[field.name] = value;
    }

    if (previousValue !== value) {
        allChanges?.push({ ref, refId, op, field: field.name, value, previousValue });
    }

    // body AFTER the slot's change: `listen()` registered inside onAdd relies on preorder
    if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
}

/** LEB128-shaped 64-bit mask (7 bits per group); returns the low 32 bits, the high 32 land in `lastMaskHigh`. */
let lastMaskHigh = 0;
function readMask64(bytes: Uint8Array, it: Iterator): number {
    let low = 0, high = 0, group = 0;
    for (;;) {
        const b = bytes[it.offset++];
        const bits = b & 0x7f;
        const shift = group * 7;
        if (shift < 32) {
            low |= bits << shift;
            if (shift > 25) high |= bits >>> (32 - shift);
        } else {
            high |= bits << (shift - 32);
        }
        if ((b & 0x80) === 0 || ++group > 9 || it.offset >= bytes.byteLength) break;
    }
    lastMaskHigh = high;
    return low;
}

/**
 * Same-shape run: `uvarint(typeId) mask64 uvarint(extra) values { uvarint(zigzag(Δ)) values }×extra`
 * following a chunk header whose length prefix carries the run flag. Every
 * masked field is a primitive ADD on a Schema of class `typeId`; members are
 * addressed by refId delta from the previous member. A member the client does
 * not know is consumed (its values are skipped) — the class table tells the
 * sizes. Returns the last member's refId (the running base for the next chunk).
 */
export function decodeRun(d: Decoder, bytes: Uint8Array, it: Iterator, end: number, refId: number, allChanges: DataChange[] | null): number {
    const typeId = readUvarint(bytes, it);
    const ctor: any = d.context.get(typeId);
    if (ctor === undefined) {
        console.warn(`@colyseus/schema: unknown typeId ${typeId} in a run (skipped)`);
        d.resyncDamaged = true;
        it.offset = end;
        return refId;
    }
    const info = getDecodeInfo(ctor);
    const mask = readMask64(bytes, it);
    if (lastMaskHigh !== 0) throw new ChunkMismatch(); // runs only carry fields 0–31
    const extra = readUvarint(bytes, it);
    const $root = d.root;
    let id = refId;
    for (let k = 0; k <= extra; k++) {
        if (k > 0) {
            const z = readUvarint(bytes, it);
            id += (z % 2 === 1) ? -((z + 1) / 2) : z / 2;
        }
        const ref = $root.getRef(id);
        let m = mask;
        if (ref === undefined) {
            console.error(`"refId" not found: ${id}`, { previousRefId: d.currentRefId });
            d.resyncDamaged = true;
            while (m !== 0) {
                const bit = m & -m;
                const index = 31 - Math.clz32(bit);
                m ^= bit;
                const reader = info.readers[index];
                if (reader === undefined) throw new ChunkMismatch();
                reader(bytes, it);
            }
            continue;
        }
        d.currentRefId = id;
        const values = refInfoOf(ref).values;
        while (m !== 0) {
            const bit = m & -m;
            const index = 31 - Math.clz32(bit);
            m ^= bit;
            if (info.readers[index] === undefined) throw new ChunkMismatch();
            decodeSchemaSlot(d, bytes, it, ref, id, info, values, index, fieldAt(info, index, ref), OPERATION.ADD, allChanges);
        }
    }
    return id;
}

export function decodeSchemaOps(d: Decoder, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null, ri?: RefInfo): void {
    if (ri === undefined) ri = refInfoOf(ref);
    const info = ri.info!;
    const values = ri.values;
    while (it.offset < end) {
        const h = readUvarint(bytes, it);
        const index = h >>> 2;
        decodeSchemaSlot(d, bytes, it, ref, refId, info, values, index, fieldAt(info, index, ref), ((h & 3) << 6) as OPERATION, allChanges);
    }
}

function decodeSchemaBody(d: Decoder, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null, ri: RefInfo): void {
    const info = ri.info!;
    const values = ri.values;

    // whole mask first (values follow it), 7 bits per group, ≤ 64 fields
    let low = 0, high = 0, group = 0;
    for (;;) {
        const b = bytes[it.offset++];
        const bits = b & 0x7f;
        const shift = group * 7;
        if (shift < 32) {
            low |= bits << shift;
            if (shift > 25) high |= bits >>> (32 - shift);
        } else {
            high |= bits << (shift - 32);
        }
        if ((b & 0x80) === 0 || ++group > 9 || it.offset >= bytes.byteLength) break;
    }

    decodeMaskedFields(d, bytes, it, ref, refId, info, values, low, 0, allChanges);
    decodeMaskedFields(d, bytes, it, ref, refId, info, values, high, 32, allChanges);
}

function decodeMaskedFields(d: Decoder, bytes: Uint8Array, it: Iterator, ref: any, refId: number, info: DecodeInfo, values: any[] | undefined, mask: number, base: number, allChanges: DataChange[] | null): void {
    while (mask !== 0) {
        const bit = mask & -mask;
        const index = base + 31 - Math.clz32(bit);
        mask ^= bit;
        decodeSchemaSlot(d, bytes, it, ref, refId, info, values, index, fieldAt(info, index, ref), OPERATION.ADD, allChanges);
    }
}

// ── Map / Set / Collection / Stream ──────────────────────────────────────

/**
 * Keyed ops: `uvarint(index * 4 + op) [key] value?` — REPLACE 0 / DELETE 1 /
 * ADD 2 (mapped back to `OPERATION` with `<< 6`), CLEAR 3. An ADD onto an
 * index that already holds a different value is a replacement
 * (`DELETE_AND_ADD` for the refcount and the callbacks). The key (MapSchema,
 * ADD ops only) is read per the map's key type.
 */
export function decodeKeyValueOps(d: Decoder, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null, isMap: boolean, ri?: RefInfo): void {
    if (ri === undefined) ri = refInfoOf(ref);
    const type = ri.childType;
    const reader = ri.reader;
    const keyReader = ri.keyReader;

    while (it.offset < end) {
        const h = readUvarint(bytes, it);
        const code = h & 3;

        if (code === KEYED_OP.CLEAR) {
            d.removeChildRefs(ref, allChanges);
            ref.clear();
            continue;
        }

        let operation = (code << 6) as OPERATION;
        const index = h >>> 2;
        let dynamicIndex: number | string;
        if (operation === OPERATION.ADD) {
            if (isMap) {
                dynamicIndex = (keyReader === undefined) ? readString(bytes, it) : keyReader(bytes, it);
                ref.keyByIndex.set(index, dynamicIndex);
                ref.indexByKey.set(dynamicIndex, index);
            } else {
                dynamicIndex = index;
            }
        } else {
            dynamicIndex = isMap ? ref.keyByIndex.get(index) : index;
        }

        const previousValue = isMap ? ref.$items.get(dynamicIndex) : ref.$items.get(index);
        let value: any;
        let header = 0;

        if (operation === OPERATION.DELETE) {
            releaseSlot(d, ref, index, operation, previousValue);
            value = undefined;
        } else {
            value = readSlotValue(d, reader, operation, previousValue, type, bytes, it, allChanges);
            header = lastHeader;
            if (operation === OPERATION.ADD && previousValue !== undefined && previousValue !== value) {
                // ADD onto an occupied slot: the entry was replaced (or removed
                // and re-set) this tick. Release the previous Schema child; a
                // previous collection was already released by resolveRef (no
                // DELETE bit) and a primitive holds no ref.
                operation = OPERATION.DELETE_AND_ADD;
                const previousRefId = refIdOfValue(previousValue);
                if (previousRefId !== undefined && Schema.is(type)) d.root.removeRef(previousRefId);
            }
        }

        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, operation, dynamicIndex, previousValue, value, allChanges);
        }

        if (value !== null && value !== undefined) storeKeyValue(ref, isMap, index, dynamicIndex, value);

        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: operation, dynamicIndex, value, previousValue });
        }

        if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
    }
}

/**
 * Map entries are keyed by their string key; Set / Collection / Stream by
 * the wire index (idempotent — a repeated ADD for a known index is a no-op,
 * and the client-side counter stays ahead of every index seen).
 */
function storeKeyValue(ref: any, isMap: boolean, index: number, dynamicIndex: number | string, value: any): void {
    if (isMap) {
        ref.$items.set(dynamicIndex, value);
    } else if (!ref.$items.has(index)) {
        ref.$items.set(index, value);
        if (ref.indexByValue !== undefined) {
            ref.indexByValue.set(value, index);
            if (index >= ref.nextIndex) ref.nextIndex = index + 1;
        } else if (ref._itemIndex !== undefined) {
            ref._itemIndex.set(value, index);
            if (index >= ref.$nextPosition) ref.$nextPosition = index + 1;
        }
    }
}

function decodeKeyValueBody(d: Decoder, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null, isMap: boolean, ri: RefInfo): void {
    const type = ri.childType;
    const reader = ri.reader;
    const keyReader = ri.keyReader;
    const count = readUvarint(bytes, it);
    for (let i = 0; i < count; i++) {
        const index = readUvarint(bytes, it);
        let dynamicIndex: number | string = index;
        if (isMap) {
            dynamicIndex = (keyReader === undefined) ? readString(bytes, it) : keyReader(bytes, it);
            ref.keyByIndex.set(index, dynamicIndex);
            ref.indexByKey.set(dynamicIndex, index);
        }
        const previousValue = ref.$items.get(dynamicIndex);
        const value = readSlotValue(d, reader, OPERATION.ADD, previousValue, type, bytes, it, allChanges);
        const header = lastHeader;
        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, OPERATION.ADD, dynamicIndex, previousValue, value, allChanges);
        }
        if (value !== null && value !== undefined) storeKeyValue(ref, isMap, index, dynamicIndex, value);
        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex, value, previousValue });
        }
        if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
    }
}

// ── Array ───────────────────────────────────────────────────────────────

/** REPLACE per slot whose occupant changed between `before` and the array's current content (reorders). */
function reportMoved(arr: any[], before: any[], ref: any, refId: number, allChanges: DataChange[]): void {
    for (let k = 0, len = arr.length; k < len; k++) {
        if (arr[k] !== before[k]) {
            allChanges.push({ ref, refId, op: OPERATION.REPLACE, dynamicIndex: k, value: arr[k], previousValue: before[k] });
        }
    }
}

/** Remove `count` elements at `index`: DELETE per element (pre-removal positions), refs released. */
function removeRange(d: Decoder, arr: any[], index: number, count: number, ref: any, refId: number, allChanges: DataChange[] | null): void {
    for (let j = 0; j < count; j++) {
        const previousValue = arr[index + j];
        const childRefId = refIdOfValue(previousValue);
        if (childRefId !== undefined) d.root.removeRef(childRefId);
        allChanges?.push({ ref, refId, op: OPERATION.DELETE, dynamicIndex: index + j, value: undefined, previousValue });
    }
    arrRemove(arr, index, count);
}

/** Append one decoded value (already refcounted) and report ADD. */
function appendValue(arr: any[], value: any, ref: any, refId: number, allChanges: DataChange[] | null): void {
    const index = arr.length;
    arr[index] = value;
    allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex: index, value, previousValue: undefined });
}

/**
 * Apply a RESTATE: `head` is `rev*2 + identity` (the op's operand, or the
 * body's leading varint), followed by `uvarint(count) value*`.
 *
 * Positional form: authoritative — sets slots 0..count-1, truncates the
 * rest, and sets the array's revision. Applied only when the client's
 * revision is older (a snapshot re-sent to a client that already holds it
 * is consumed without effect). Identity form (filtered arrays): merge —
 * known refs keep their position, unknown ones append.
 */
function applyRestate(d: Decoder, bytes: Uint8Array, it: Iterator, arr: any, ref: any, refId: number, allChanges: DataChange[] | null, head: number, ri: RefInfo): void {
    const type = ri.childType;
    const reader = ri.reader;
    const $root = d.root;
    const count = readUvarint(bytes, it);
    const resync = d.resyncVisited !== null;

    if ((head & 1) === 1) {
        // identity: merge by refId
        for (let i = 0; i < count; i++) {
            const header = readUvarint(bytes, it);
            const existing = $root.getRef(refIdOf(header));
            let index = (existing !== undefined) ? arrIndexOf(arr, existing) : -1;
            let value: any;
            if (index === -1) {
                value = resolveRef(d, header, OPERATION.ADD, undefined, type, bytes, it, allChanges);
                index = arr.length;
                appendValue(arr, value, ref, refId, allChanges);
            } else {
                value = resolveRef(d, header, OPERATION.ADD, existing, type, bytes, it, allChanges);
            }
            if (resync) resyncRecordVisit(d, -1 - refIdOf(header));
            if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
        }
        return;
    }

    const restateRev = head < 0x80000000 ? head >>> 1 : Math.floor(head / 2);
    const rev: number = ref[$rev] ?? 0;
    if (rev >= restateRev && !(rev === 0 && restateRev === 0)) {
        // already at (or past) this revision: consume without applying
        for (let i = 0; i < count; i++) skipValue(d, reader, type, bytes, it, allChanges);
        if (resync) for (let i = 0, len = arr.length; i < len; i++) resyncRecordVisit(d, i);
        return;
    }

    if (reader !== undefined || arr.length === 0) {
        // primitives (or a fresh client array): positional diff
        for (let i = 0; i < count; i++) {
            const previousValue = arr[i];
            let value: any;
            let header = 0;
            if (reader !== undefined) {
                value = reader(bytes, it);
            } else {
                header = readUvarint(bytes, it);
                value = resolveRef(d, header, OPERATION.ADD, undefined, type, bytes, it, allChanges);
            }
            if (resync) resyncRecordVisit(d, i);
            if (previousValue !== value) {
                arr[i] = value;
                allChanges?.push({
                    ref, refId,
                    op: (previousValue === undefined) ? OPERATION.ADD : OPERATION.REPLACE,
                    dynamicIndex: i, value, previousValue,
                });
            }
            if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
        }
        if (arr.length > count) removeRange(d, arr, count, arr.length - count, ref, refId, allChanges);
        ref[$rev] = restateRev;
        return;
    }

    // Schema children over a populated client array: diff by identity, so a
    // re-statement reports the elements that actually left / arrived (and a
    // REPLACE for slots whose survivor moved), never a churn per slot.
    const before: any[] = arrCopy(arr);
    const oldSet = new Set<any>(before);
    const after: any[] = new Array(count);
    const newSet = new Set<any>();
    for (let i = 0; i < count; i++) {
        const header = readUvarint(bytes, it);
        const existing = $root.getRef(refIdOf(header));
        const survivor = (existing !== undefined && oldSet.has(existing)) ? existing : undefined;
        const value = resolveRef(d, header, OPERATION.ADD, survivor, type, bytes, it, allChanges);
        after[i] = value;
        newSet.add(value);
        if (resync) resyncRecordVisit(d, i);
        if (survivor === undefined) {
            allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex: i, value, previousValue: undefined });
        }
        if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
    }
    for (let i = 0; i < before.length; i++) {
        const previousValue = before[i];
        if (newSet.has(previousValue)) continue;
        const previousRefId = refIdOfValue(previousValue);
        if (previousRefId !== undefined) $root.removeRef(previousRefId);
        allChanges?.push({ ref, refId, op: OPERATION.DELETE, dynamicIndex: i, value: undefined, previousValue });
    }
    arr.length = count;
    for (let i = 0; i < count; i++) {
        const value = after[i];
        const previousValue = before[i];
        arr[i] = value;
        if (allChanges !== null && previousValue !== undefined && previousValue !== value && oldSet.has(value) && newSet.has(previousValue)) {
            allChanges.push({ ref, refId, op: OPERATION.REPLACE, dynamicIndex: i, value, previousValue }); // a survivor moved here
        }
    }
    ref[$rev] = restateRev;
}

/**
 * Array chunk: `arrayOp*`, each `uvarint(arg * 16 + op)` plus operands. The
 * sequence starts at the client's revision (or at a `BASE` op's operand);
 * every op advances it by its weight. An op whose whole weight lies below
 * the client's revision was already delivered by a snapshot and is consumed
 * without effect; an op the revision falls inside is applied from that
 * point on.
 */
export function decodeArrayOps(d: Decoder, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null, ri?: RefInfo): void {
    if (ri === undefined) ri = refInfoOf(ref);
    const arr: any[] = ref; // element storage is the instance itself (Array subclass)
    const type = ri.childType;
    const reader = ri.reader;
    const $root = d.root;
    const resync = d.resyncVisited !== null;

    let rev: number = ref[$rev] ?? 0;
    // the log resumes at this client's own revision unless a BASE op says otherwise
    let seq = rev;

    while (it.offset < end) {
        const head = readUvarint(bytes, it);
        const op = head % 16;
        const arg = (head - op) / 16;
        switch (op) {
            case ARRAY_OP.PUSH: {
                const n = arg;
                let skip = rev - seq;
                if (skip < 0) skip = 0; else if (skip > n) skip = n;
                for (let i = 0; i < n; i++) {
                    if (i < skip) { skipValue(d, reader, type, bytes, it, allChanges); continue; }
                    let header = 0, value: any;
                    if (reader !== undefined) value = reader(bytes, it);
                    else { header = readUvarint(bytes, it); value = resolveRef(d, header, OPERATION.ADD, undefined, type, bytes, it, allChanges); }
                    if (resync) resyncRecordVisit(d, arr.length);
                    appendValue(arr, value, ref, refId, allChanges);
                    if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
                }
                seq += n;
                break;
            }
            case ARRAY_OP.INSERT: {
                const index = arg;
                const n = readUvarint(bytes, it);
                let skip = rev - seq;
                if (skip < 0) skip = 0; else if (skip > n) skip = n;
                for (let i = 0; i < n; i++) {
                    if (i < skip) { skipValue(d, reader, type, bytes, it, allChanges); continue; }
                    let header = 0, value: any;
                    if (reader !== undefined) value = reader(bytes, it);
                    else { header = readUvarint(bytes, it); value = resolveRef(d, header, OPERATION.ADD, undefined, type, bytes, it, allChanges); }
                    const at = index + i;
                    arrInsertOne(arr, at, value);
                    if (resync) resyncRecordVisit(d, at);
                    allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex: at, value, previousValue: undefined });
                    if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
                }
                seq += n;
                break;
            }
            case ARRAY_OP.SET: {
                const index = arg;
                if (rev > seq) {
                    skipValue(d, reader, type, bytes, it, allChanges);
                } else {
                    const previousValue = arr[index];
                    let header = 0, value: any;
                    if (reader !== undefined) value = reader(bytes, it);
                    else { header = readUvarint(bytes, it); value = resolveRef(d, header, OPERATION.ADD, previousValue, type, bytes, it, allChanges); }
                    if (resync) resyncRecordVisit(d, index);
                    if (previousValue !== value) {
                        const previousRefId = refIdOfValue(previousValue);
                        if (previousRefId !== undefined) $root.removeRef(previousRefId);
                        arr[index] = value;
                        allChanges?.push({
                            ref, refId,
                            op: (previousRefId !== undefined) ? OPERATION.DELETE_AND_ADD : OPERATION.REPLACE,
                            dynamicIndex: index, value, previousValue,
                        });
                    }
                    if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
                }
                seq += 1;
                break;
            }
            case ARRAY_OP.REMOVE: {
                const index = arg;
                const n = readUvarint(bytes, it);
                let skip = rev - seq;
                if (skip < 0) skip = 0; else if (skip > n) skip = n;
                if (n - skip > 0) removeRange(d, arr, index, n - skip, ref, refId, allChanges);
                seq += n;
                break;
            }
            case ARRAY_OP.REVERSE: {
                if (rev <= seq && arr.length > 1) {
                    const before = (allChanges !== null) ? arrCopy(arr) : undefined;
                    arrReverse(arr);
                    if (before !== undefined) reportMoved(arr, before, ref, refId, allChanges!);
                }
                seq += 1;
                break;
            }
            case ARRAY_OP.REORDER: {
                const n = arg;
                if (rev <= seq) {
                    const before = arrCopy(arr);
                    for (let k = 0; k < n; k++) arr[k] = before[readUvarint(bytes, it)];
                    if (allChanges !== null) reportMoved(arr, before, ref, refId, allChanges);
                } else {
                    for (let k = 0; k < n; k++) readUvarint(bytes, it);
                }
                seq += 1;
                break;
            }
            case ARRAY_OP.CLEAR: {
                if (rev <= seq) {
                    d.removeChildRefs(ref, allChanges);
                    arr.length = 0;
                }
                seq += 1;
                break;
            }
            case ARRAY_OP.RESTATE: {
                applyRestate(d, bytes, it, arr, ref, refId, allChanges, arg, ri);
                const restated: number = ref[$rev] ?? 0;
                if (restated > seq) seq = restated;
                rev = restated;
                break;
            }
            case ARRAY_OP.ADD_REF: {
                // the ref header doubles as the operand: refId once on the wire
                const header = readUvarint(bytes, it);
                const existing = $root.getRef(refIdOf(header));
                let index = (existing !== undefined) ? arrIndexOf(arr, existing) : -1;
                let value: any;
                if (index === -1) {
                    value = resolveRef(d, header, OPERATION.ADD, undefined, type, bytes, it, allChanges);
                    appendValue(arr, value, ref, refId, allChanges);
                } else {
                    value = resolveRef(d, header, OPERATION.ADD, existing, type, bytes, it, allChanges);
                }
                if (resync) resyncRecordVisit(d, -1 - refIdOf(header));
                if (header & REF_HAS_BODY) decodeBody(d, value, bytes, it, allChanges);
                break;
            }
            case ARRAY_OP.DELETE_REF: {
                const childRefId = arg;
                const previousValue = $root.getRef(childRefId);
                if (previousValue === undefined) break; // stale: never held here
                // release even when absent from THIS array (view churn) — the
                // refId must not leak into a later reuse
                $root.removeRef(childRefId);
                const index = arrIndexOf(arr, previousValue);
                if (index === -1) break;
                arrRemove(arr, index, 1);
                allChanges?.push({ ref, refId, op: OPERATION.DELETE, dynamicIndex: index, value: undefined, previousValue });
                break;
            }
            case ARRAY_OP.BASE: {
                seq = arg;
                break;
            }
            default:
                console.warn("@colyseus/schema: unknown array op", op);
                throw new ChunkMismatch();
        }
    }

    if (seq > rev) rev = seq;
    ref[$rev] = rev;
}

function decodeArrayBody(d: Decoder, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null, ri: RefInfo): void {
    const arr: any[] = ref;
    applyRestate(d, bytes, it, arr, ref, refId, allChanges, readUvarint(bytes, it), ri);
}
