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
    metadata: Metadata,
) {
    // "compress" field index + operation
    bytes[it.offset++] = (index | operation) & 255;

    // Do not encode value for DELETE operations
    if (operation === OPERATION.DELETE) {
        return;
    }

    // Single metadata[index] read instead of three chases (was: name, type,
    // and encoders[index] — each a separate property load on the field obj).
    const field = metadata[index];
    const ref = changeTree.ref as any;

    // Direct $values[index] read — bypasses prototype getter + metadata name lookup.
    // Falls back to named property for manual fields (which don't use $values).
    const value = ref[$values][index] ?? ref[field.name];

    encodeValue(
        encoder,
        bytes,
        field.type,
        value,
        operation,
        it,
        metadata[$encoders]?.[index],
    );
}

/**
 * Used for collections (MapSchema, CollectionSchema, SetSchema)
 * @private
 */
export const encodeKeyValueOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: Uint8Array,
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    // encode operation
    bytes[it.offset++] = operation & 255;

    // encode index
    encode.number(bytes, index, it);

    // Do not encode value for DELETE operations
    if (operation === OPERATION.DELETE) {
        return;
    }

    const ref = changeTree.ref;

    //
    // encode "alias" for dynamic fields (maps)
    //
    if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
        if (typeof(ref['set']) === "function") {
            //
            // MapSchema dynamic key
            //
            const dynamicIndex = changeTree.ref['$indexes'].get(index);
            encode.string(bytes, dynamicIndex, it);
        }
    }

    const type = ref[$childType];
    const value = ref[$getByIndex](index);

    // try { throw new Error(); } catch (e) {
    //     // only print if not coming from Reflection.ts
    //     if (!e.stack.includes("src/Reflection.ts")) {
    //         console.log("encodeKeyValueOperation -> ", {
    //             ref: changeTree.ref.constructor.name,
    //             field,
    //             operation: OPERATION[operation],
    //             value: value?.toJSON(),
    //             items: ref.toJSON(),
    //         });
    //     }
    // }

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
    const ref = changeTree.ref;
    const useOperationByRefId = hasView && changeTree.isFiltered && (typeof (changeTree.getType(field)) !== "string");

    let refOrIndex: number;

    if (useOperationByRefId) {
        const item = ref['tmpItems'][field];

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

    const type = changeTree.getType(field);
    const value = changeTree.getValue(field, isEncodeAll);

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