import { OPERATION } from "../encoding/spec";
import { $changes, $childType, $getByIndex } from "../types/symbols";

import { encode } from "../encoding/encode";

import type { ChangeTree, Ref } from "./ChangeTree";
import type { Encoder } from "./Encoder";
import type { Schema } from "../Schema";

import type { Iterator } from "../encoding/decode";
import type { ArraySchema } from "../types/custom/ArraySchema";
import type { Metadata } from "../Metadata";

export type EncodeOperation<T extends Ref = any> = (
    encoder: Encoder,
    bytes: Buffer,
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
    bytes: Buffer,
    type: any,
    value: any,
    operation: OPERATION,
    it: Iterator,
) {
    if (typeof (type) === "string") {
        encode[type]?.(bytes, value, it);

    } else if (type[Symbol.metadata] !== undefined) {
        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId, it);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema, it);
        }

    } else {
        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId, it);
    }
}

/**
 * Used for Schema instances.
 * @private
 */
export const encodeSchemaOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: Buffer,
    changeTree: ChangeTree<Schema>,
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

    const ref = changeTree.ref;
    const field = metadata[index];

    // TODO: inline this function call small performance gain
    encodeValue(
        encoder,
        bytes,
        metadata[index].type,
        ref[field.name],
        operation,
        it
    );
}

/**
 * Used for collections (MapSchema, CollectionSchema, SetSchema)
 * @private
 */
export const encodeKeyValueOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: Buffer,
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    // encode operation
    bytes[it.offset++] = operation & 255;

    // custom operations
    if (operation === OPERATION.CLEAR) {
        return;
    }

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
    bytes: Buffer,
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
        refOrIndex = ref['tmpItems'][field][$changes].refId;

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

    // custom operations
    if (
        operation === OPERATION.CLEAR ||
        operation === OPERATION.REVERSE
    ) {
        return;
    }

    // encode index
    encode.number(bytes, refOrIndex, it);

    // Do not encode value for DELETE operations
    if (operation === OPERATION.DELETE) {
        return;
    }

    const type = changeTree.getType(field);
    const value = changeTree.getValue(field, isEncodeAll);

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