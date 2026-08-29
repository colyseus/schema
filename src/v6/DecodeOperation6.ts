import { OPERATION } from "../encoding/spec.js";
import type { Iterator } from "../encoding/decode.js";
import { Schema } from "../Schema.js";
import type { Metadata } from "../Metadata.js";
import { $childType, $deleteByIndex, $proxyTarget, $refId } from "../types/symbols.js";
import { getType } from "../types/registry.js";
import { decodeQuantized, isQuantizedType } from "../types/quantize.js";
import { CollectionKind, type DataChange } from "../decoder/DecodeOperation.js";
import { resyncMarkPresent, resyncTouchEntry } from "../decoder/Resync.js";
import type { Decoder6 } from "./Decoder6.js";
import { decode6, readString6, readUvarint } from "./encoding.js";
import { REF_HAS_BODY, REF_HAS_TYPE } from "./spec.js";
import { getV6DecodeInfo, type V6DecodeInfo } from "./classInfo.js";

/** Thrown on a definition mismatch inside a chunk; the chunk loop skips to the chunk end. */
export class ChunkMismatch extends Error {}

type Reader = (bytes: Uint8Array, it: Iterator) => any;

/** Reader for a collection's child type: pre-resolved once per chunk / body, `undefined` for ref children. */
function childReaderOf(type: any): Reader | undefined {
    if (typeof type === "string") return decode6[type];
    if (isQuantizedType(type)) return (bytes, it) => decodeQuantized(type.quantized, bytes, it);
    return undefined;
}

/**
 * Ref header of the value just read by `readSlotValue` (0 for primitives).
 * Module-level so the per-slot path returns one primitive and allocates
 * nothing; callers consume it immediately, before any nested read.
 */
let lastHeader = 0;

function readSlotValue(d: Decoder6, reader: Reader | undefined, op: OPERATION, previousValue: any, type: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): any {
    if (reader !== undefined) {
        lastHeader = 0;
        return reader(bytes, it);
    }
    const header = readUvarint(bytes, it);
    lastHeader = header;
    return resolveRef6(d, header, op, previousValue, type, bytes, it, allChanges);
}

/** `refId` from a ref header; refIds stay far below 2^29 so the shift is exact. */
function refIdOf(header: number): number {
    return header < 0x80000000 ? header >>> 2 : Math.floor(header / 4);
}

/**
 * Resolve a ref value header into an instance, applying v5's refcount rules
 * (`decodeValue`, DecodeOperation.ts:135-217). Does NOT decode the body.
 */
function resolveRef6(
    d: Decoder6,
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
        let value = $root.refs.get(refId);
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
    const typeDef = getType(kind);
    if (d.resyncVisited !== null) resyncMarkPresent(d, refId);

    const valueRef: any = ($root.refs.has(refId))
        ? previousValue || $root.refs.get(refId)
        : (typeDef.constructor as any).initializeForDecoder();

    const value = valueRef.clone(true);
    value[$childType] = childType;

    if (previousValue) {
        let previousRefId = previousValue[$refId];
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
                if (typeof v === "object") previousRefId = v[$refId];
                allChanges?.push({ ref: previousValue, refId: previousRefId, op: OPERATION.DELETE, field: key, value: undefined, previousValue: v });
            }
        }
    }

    $root.addRef(refId, value, (
        valueRef !== previousValue ||
        (op === OPERATION.DELETE_AND_ADD && valueRef === previousValue)
    ));
    return value;
}

/** DELETE-bit prologue shared by every op path: release the previous ref, clear the slot unless it is being re-set. */
function releaseSlot(d: Decoder6, ref: any, index: number, op: OPERATION, previousValue: any): void {
    const previousRefId = previousValue?.[$refId];
    if (previousRefId !== undefined) d.root.removeRef(previousRefId);
    if (op !== OPERATION.DELETE_AND_ADD) ref[$deleteByIndex](index);
}

function fieldAt(info: V6DecodeInfo, index: number, ref: any): any {
    const field = info.fields[index];
    if (field === undefined) {
        console.warn("@colyseus/schema: field not defined at", { index, ref: ref.constructor.name });
        throw new ChunkMismatch();
    }
    return field;
}

/** Decode an inline body into `value` (kind-dispatched). Restores `currentRefId` afterwards. */
export function decodeBody6(d: Decoder6, value: any, bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): void {
    const saved = d.currentRefId;
    const refId: number = value[$refId];
    d.currentRefId = refId;
    const kind = (value.constructor as any).COLLECTION_KIND;
    if (kind === undefined) decodeSchemaBody6(d, bytes, it, value, refId, allChanges);
    else if (kind === CollectionKind.Array) decodeArrayBody6(d, bytes, it, value, refId, allChanges);
    else decodeKeyValueBody6(d, bytes, it, value, refId, allChanges, kind === CollectionKind.Map);
    d.currentRefId = saved;
}

// ── Schema ──────────────────────────────────────────────────────────────

function decodeSchemaSlot(
    d: Decoder6, bytes: Uint8Array, it: Iterator, ref: any, refId: number,
    info: V6DecodeInfo, index: number, field: any, op: OPERATION, allChanges: DataChange[] | null,
): void {
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
        // bytes consumed, nothing written or reported (v5 rule)
        if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
        return;
    }

    if (value !== null && value !== undefined) {
        ref[field.name] = value;
    }

    if (previousValue !== value) {
        allChanges?.push({ ref, refId, op, field: field.name, value, previousValue });
    }

    // body AFTER the slot's change: `listen()` registered inside onAdd relies on preorder
    if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
}

export function decodeSchemaOps6(d: Decoder6, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null): void {
    const info = getV6DecodeInfo(ref.constructor);
    while (it.offset < end) {
        const h = readUvarint(bytes, it);
        const index = h >>> 2;
        decodeSchemaSlot(d, bytes, it, ref, refId, info, index, fieldAt(info, index, ref), ((h & 3) << 6) as OPERATION, allChanges);
    }
}

function decodeSchemaBody6(d: Decoder6, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null): void {
    const info = getV6DecodeInfo(ref.constructor);

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

    decodeMaskedFields(d, bytes, it, ref, refId, info, low, 0, allChanges);
    decodeMaskedFields(d, bytes, it, ref, refId, info, high, 32, allChanges);
}

function decodeMaskedFields(d: Decoder6, bytes: Uint8Array, it: Iterator, ref: any, refId: number, info: V6DecodeInfo, mask: number, base: number, allChanges: DataChange[] | null): void {
    while (mask !== 0) {
        const bit = mask & -mask;
        const index = base + 31 - Math.clz32(bit);
        mask ^= bit;
        decodeSchemaSlot(d, bytes, it, ref, refId, info, index, fieldAt(info, index, ref), OPERATION.ADD, allChanges);
    }
}

// ── Map / Set / Collection / Stream ──────────────────────────────────────

export function decodeKeyValueOps6(d: Decoder6, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null, isMap: boolean): void {
    const tgt: any = ref[$proxyTarget] ?? ref;
    const type = tgt[$childType];
    const reader = childReaderOf(type);

    while (it.offset < end) {
        const operation: OPERATION = bytes[it.offset++];

        if (operation === OPERATION.CLEAR) {
            d.removeChildRefs(tgt, allChanges);
            tgt.clear();
            continue;
        }

        const index = readUvarint(bytes, it);
        let dynamicIndex: number | string;
        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            if (isMap) {
                dynamicIndex = readString6(bytes, it);
                tgt.setIndex(index, dynamicIndex);
            } else {
                dynamicIndex = index;
            }
        } else {
            dynamicIndex = tgt.getIndex(index);
        }

        const previousValue = isMap ? tgt.$items.get(dynamicIndex) : tgt.$items.get(index);
        let value: any;
        let header = 0;

        if ((operation & OPERATION.DELETE) === OPERATION.DELETE) {
            releaseSlot(d, tgt, index, operation, previousValue);
            value = undefined;
        }
        if (operation !== OPERATION.DELETE) {
            value = readSlotValue(d, reader, operation, previousValue, type, bytes, it, allChanges);
            header = lastHeader;
        }

        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, operation, dynamicIndex, previousValue, value, allChanges);
        }

        if (value !== null && value !== undefined) storeKeyValue(tgt, isMap, index, dynamicIndex, value);

        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: operation, dynamicIndex, value, previousValue });
        }

        if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
    }
}

/** Map entries are keyed by their string key; Set/Collection/Stream by the wire index (idempotent, keeps the client counter ahead). */
function storeKeyValue(tgt: any, isMap: boolean, index: number, dynamicIndex: number | string, value: any): void {
    if (isMap) {
        tgt.$items.set(dynamicIndex, value);
    } else if (!tgt.$items.has(index)) {
        tgt.$items.set(index, value);
        if (typeof tgt.$refId === "number" && index >= tgt.$refId) tgt.$refId = index + 1;
    }
}

function decodeKeyValueBody6(d: Decoder6, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null, isMap: boolean): void {
    const tgt: any = ref[$proxyTarget] ?? ref;
    const type = tgt[$childType];
    const reader = childReaderOf(type);
    const count = readUvarint(bytes, it);
    for (let i = 0; i < count; i++) {
        const index = readUvarint(bytes, it);
        let dynamicIndex: number | string = index;
        if (isMap) {
            dynamicIndex = readString6(bytes, it);
            tgt.setIndex(index, dynamicIndex);
        }
        const previousValue = tgt.$items.get(dynamicIndex);
        const value = readSlotValue(d, reader, OPERATION.ADD, previousValue, type, bytes, it, allChanges);
        const header = lastHeader;
        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, OPERATION.ADD, dynamicIndex, previousValue, value, allChanges);
        }
        if (value !== null && value !== undefined) storeKeyValue(tgt, isMap, index, dynamicIndex, value);
        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex, value, previousValue });
        }
        if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
    }
}

// ── Array ───────────────────────────────────────────────────────────────

export function decodeArrayOps6(d: Decoder6, bytes: Uint8Array, it: Iterator, end: number, ref: any, refId: number, allChanges: DataChange[] | null): void {
    const tgt: any = ref[$proxyTarget] ?? ref;
    const type = tgt[$childType];
    const reader = childReaderOf(type);
    const $root = d.root;

    while (it.offset < end) {
        const operation: OPERATION = bytes[it.offset++];
        let index: number;
        let header = 0;
        let value: any;
        let previousValue: any;

        if (operation === OPERATION.CLEAR) {
            d.removeChildRefs(tgt, allChanges);
            tgt.clear();
            continue;

        } else if (operation === OPERATION.REVERSE) {
            tgt.items.reverse();
            continue;

        } else if (operation === OPERATION.DELETE_BY_REFID) {
            const childRefId = readUvarint(bytes, it);
            previousValue = $root.refs.get(childRefId);
            if (previousValue === undefined) continue; // stale: never held here
            $root.removeRef(childRefId);
            index = tgt.items.indexOf(previousValue);
            if (index === -1) continue;
            tgt[$deleteByIndex](index);
            allChanges?.push({ ref, refId, op: OPERATION.DELETE, dynamicIndex: index, value: undefined, previousValue });
            continue;

        } else if (operation === OPERATION.ADD_BY_REFID) {
            // the ref header doubles as the index operand: refId once on the wire
            header = readUvarint(bytes, it);
            const existing = $root.refs.get(refIdOf(header));
            index = (existing !== undefined) ? tgt.items.indexOf(existing) : -1;
            if (index === -1) index = tgt.items.length;
            previousValue = tgt.items[index];
            value = resolveRef6(d, header, operation, previousValue, type, bytes, it, allChanges);

        } else {
            index = readUvarint(bytes, it);
            previousValue = tgt.items[index];

            if ((operation & OPERATION.DELETE) === OPERATION.DELETE) {
                releaseSlot(d, tgt, index, operation, previousValue);
                value = undefined;
            }
            if (operation !== OPERATION.DELETE) {
                value = readSlotValue(d, reader, operation, previousValue, type, bytes, it, allChanges);
                header = lastHeader;
            }
        }

        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, operation, index, previousValue, value, allChanges);
        }

        if (value !== null && value !== undefined && value !== previousValue) {
            tgt.$setAt(index, value,
                (d.resyncVisited !== null && operation === OPERATION.ADD) ? OPERATION.REPLACE : operation);
        }

        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: operation, dynamicIndex: index, value, previousValue });
        }

        if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
    }
}

/**
 * Array body: positional for primitives. Schema children use identity
 * placement when the client array is non-empty outside resync (a filtered
 * client may already hold some elements at other positions); resync and
 * empty arrays are positional.
 */
function decodeArrayBody6(d: Decoder6, bytes: Uint8Array, it: Iterator, ref: any, refId: number, allChanges: DataChange[] | null): void {
    const tgt: any = ref[$proxyTarget] ?? ref;
    const type = tgt[$childType];
    const reader = childReaderOf(type);
    const $root = d.root;
    const count = readUvarint(bytes, it);
    const identityPlacement = reader === undefined && d.resyncVisited === null && tgt.items.length > 0;

    for (let i = 0; i < count; i++) {
        let index = i;
        let header = 0;
        let value: any;
        let previousValue: any;

        if (reader === undefined) {
            header = readUvarint(bytes, it);
            if (identityPlacement) {
                const existing = $root.refs.get(refIdOf(header));
                index = (existing !== undefined) ? tgt.items.indexOf(existing) : -1;
                if (index === -1) index = tgt.items.length;
            }
            previousValue = tgt.items[index];
            value = resolveRef6(d, header, OPERATION.ADD, previousValue, type, bytes, it, allChanges);
        } else {
            previousValue = tgt.items[index];
            value = reader(bytes, it);
        }

        if (d.resyncVisited !== null) {
            resyncTouchEntry(d, ref, OPERATION.ADD, index, previousValue, value, allChanges);
        }

        if (value !== null && value !== undefined && value !== previousValue) {
            tgt.$setAt(index, value, OPERATION.REPLACE); // a body re-states, never inserts
        }

        if (previousValue !== value) {
            allChanges?.push({ ref, refId, op: OPERATION.ADD, dynamicIndex: index, value, previousValue });
        }

        if (header & REF_HAS_BODY) decodeBody6(d, value, bytes, it, allChanges);
    }
}
