import { OPERATION } from "../encoding/spec.js";
import { $changes, $childType, $encoders, $getByIndex, $refId, $values } from "../types/symbols.js";

import { encode } from "../encoding/encode.js";

import type { ChangeTree, Ref } from "./ChangeTree.js";
import type { Encoder } from "./Encoder.js";
import type { Schema } from "../Schema.js";

import type { Iterator } from "../encoding/decode.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { Metadata } from "../Metadata.js";

export type EncodeOperation<T extends Ref = any> = (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree<T>,
    index: number,
    operation: OPERATION,
    it: Iterator,
    isEncodeAll: boolean,
    hasView: boolean,
    metadata?: Metadata,
) => void;

export function encodeValue(
    encoder: Encoder,
    bytes: Uint8Array,
    type: any,
    value: any,
    operation: OPERATION,
    it: Iterator,
    encoderFn?: (bytes: Uint8Array, value: any, it: Iterator) => void,
) {
    if (encoderFn !== undefined) {
        // Fast path: pre-computed encoder for primitive types.
        encoderFn(bytes, value, it);

    } else if (typeof (type) === "string") {
        // Fallback for types not pre-computed (e.g. runtime-constructed).
        (encode as any)[type]?.(bytes, value, it);

    } else if (type[Symbol.metadata] !== undefined) {
        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$refId], it);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema, it);
        }

    } else {
        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$refId], it);
    }
}

/**
 * Used for Schema instances.
 * @private
 */
export const encodeSchemaOperation: EncodeOperation = function <T extends Schema> (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree<T>,
    index: number,
    operation: OPERATION,
    it: Iterator,
    _: any,
    __: any,
) {
    // "compress" field index + operation
    bytes[it.offset++] = (index | operation) & 255;

    // Do not encode value for DELETE operations
    if (operation === OPERATION.DELETE) {
        return;
    }

    // Read field info from the per-class descriptor's parallel arrays —
    // replaces `metadata[index]` (returns a per-field obj) + `.name` /
    // `.type` chains. The `encoders` array is also pre-baked here so we
    // skip a `metadata[$encoders]?.[index]` symbol-keyed lookup per call.
    const desc = changeTree.encDescriptor;
    const ref = changeTree.ref as any;

    // Direct $values[index] read — bypasses prototype getter + metadata name lookup.
    // Falls back to named property for manual fields (which don't use $values).
    const value = ref[$values][index] ?? ref[desc.names[index]];

    encodeValue(
        encoder,
        bytes,
        desc.types[index],
        value,
        operation,
        it,
        desc.encoders[index],
    );
}

/**
 * Encode a single MapSchema entry. Splits the legacy
 * `encodeKeyValueOperation` so the per-emission `typeof ref['set']` check
 * is gone — MapSchema instances are routed here via their `[$encoder]`
 * static, the dynamic-key string emission is unconditional on ADD.
 *
 * @private
 */
export const encodeMapEntry: EncodeOperation = function (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    bytes[it.offset++] = operation & 255;
    encode.number(bytes, index, it);

    if (operation === OPERATION.DELETE) return;

    const ref = changeTree.ref;

    // ADD or DELETE_AND_ADD: emit the user-facing string key for dynamic
    // map fields. SetSchema/CollectionSchema use a different encoder and
    // skip this entirely (no dynamic key).
    if ((operation & OPERATION.ADD) === OPERATION.ADD) {
        const dynamicIndex = (ref as any)['$indexes'].get(index);
        encode.string(bytes, dynamicIndex, it);
    }

    encodeValue(
        encoder,
        bytes,
        (ref as any)[$childType],
        ref[$getByIndex](index),
        operation,
        it,
    );
}

/**
 * Encode a single SetSchema / CollectionSchema entry. Wire format is the
 * same as MapSchema minus the dynamic-key string, so this path skips the
 * legacy `typeof ref['set']` check entirely.
 *
 * @private
 */
export const encodeIndexedEntry: EncodeOperation = function (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    bytes[it.offset++] = operation & 255;
    encode.number(bytes, index, it);

    if (operation === OPERATION.DELETE) return;

    const ref = changeTree.ref;
    encodeValue(
        encoder,
        bytes,
        (ref as any)[$childType],
        ref[$getByIndex](index),
        operation,
        it,
    );
}

/**
 * Unified encoder kept for back-compat with external consumers that may
 * have registered it directly via `static [$encoder] =
 * encodeKeyValueOperation`. New code (and all internal collections)
 * should use the split variants — `encodeMapEntry` for MapSchema and
 * `encodeIndexedEntry` for SetSchema / CollectionSchema.
 *
 * The runtime `typeof ref['set']` check below is the per-emission cost
 * the split is designed to remove.
 */
export const encodeKeyValueOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    const ref = changeTree.ref as any;
    if ((operation & OPERATION.ADD) === OPERATION.ADD && typeof ref['set'] === "function") {
        encodeMapEntry(encoder, bytes, changeTree, index, operation, it, false, false);
    } else {
        encodeIndexedEntry(encoder, bytes, changeTree, index, operation, it, false, false);
    }
}

/**
 * Used for collections (MapSchema, ArraySchema, etc.)
 * @private
 */
export const encodeArray: EncodeOperation = function (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree<ArraySchema>,
    field: number,
    operation: OPERATION,
    it: Iterator,
    isEncodeAll: boolean,
    hasView: boolean,
) {
    // Read through `refTarget` so every property access below skips the
    // ArraySchema Proxy `get` trap. `refTarget` points at the raw backing
    // instance; `ref` (the Proxy) stays the user-facing identity.
    const ref = changeTree.refTarget as any;
    // Read $childType once and reuse — old code went through
    // `changeTree.getType(field)` twice (once for the typeof check, once
    // for `type`), each going through a method dispatch + dead Schema
    // fallback (`metadata[index].type` is unreachable for arrays).
    const type = ref[$childType];
    const useOperationByRefId = hasView && changeTree.isFiltered && typeof type !== "string";

    let refOrIndex: number;

    if (useOperationByRefId) {
        const item = ref.tmpItems[field];

        // Skip encoding if item is undefined (e.g. when clear() is called)
        if (!item) { return; }

        refOrIndex = item[$refId];

        if (operation === OPERATION.DELETE) {
            operation = OPERATION.DELETE_BY_REFID;

        } else if (operation === OPERATION.ADD) {
            operation = OPERATION.ADD_BY_REFID;
        }

    } else {
        refOrIndex = field;
    }

    // encode operation
    bytes[it.offset++] = operation & 255;

    // encode index
    encode.number(bytes, refOrIndex, it);

    // Do not encode value for DELETE operations
    if (operation === OPERATION.DELETE || operation === OPERATION.DELETE_BY_REFID) {
        return;
    }

    // `type` was already read above. Direct $getByIndex call — skips
    // ChangeTree.getValue's pass-through wrapper.
    const value = ref[$getByIndex](field, isEncodeAll);

    // console.log({ type, field, value });

    // console.log("encodeArray -> ", {
    //     ref: changeTree.ref.constructor.name,
    //     field,
    //     operation: OPERATION[operation],
    //     value: value?.toJSON(),
    //     items: ref.toJSON(),
    // });

    // TODO: inline this function call small performance gain
    encodeValue(
        encoder,
        bytes,
        type,
        value,
        operation,
        it
    );
}