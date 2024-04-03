import { OPERATION } from "../encoding/spec";
import { $changes } from "../types/symbols";
import { getType } from "../types/registry";

import * as encode from "../encoding/encode";
import { EncodeSchemaError, assertInstanceType, assertType } from "../encoding/assert";

import type { ChangeTree, Ref } from "./ChangeTree";
import type { Encoder } from "./Encoder";
import type { Schema } from "../Schema";
import type { PrimitiveType } from "../annotations";

import type { Iterator } from "../encoding/decode";

export type EncodeOperation<T extends Ref = any> = (
    encoder: Encoder,
    bytes: Buffer,
    changeTree: ChangeTree<T>,
    index: number,
    operation: OPERATION,
    it: Iterator
) => void;

export function encodePrimitiveType(
    type: PrimitiveType,
    bytes: Buffer,
    value: any,
    klass: Schema,
    field: string | number,
    it: Iterator,
) {
    assertType(value, type as string, klass, field);

    const encodeFunc = encode[type as string];

    if (encodeFunc) {
        encodeFunc(bytes, value, it);
        // encodeFunc(bytes, value);

    } else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}

export function encodeValue(
    encoder: Encoder,
    bytes: Buffer,
    ref: Schema,
    type: any,
    value: any,
    field: string | number,
    operation: OPERATION,
    it: Iterator,
) {
    if (type[Symbol.metadata] !== undefined) {
        assertInstanceType(value, type as typeof Schema, ref as Schema, field);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId, it);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema, it);
        }

    } else if (typeof (type) === "string") {
        //
        // Primitive values
        //
        encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, field, it);

    } else {
        //
        // Custom type (MapSchema, ArraySchema, etc)
        //
        const definition = getType(Object.keys(type)[0]);

        //
        // ensure a ArraySchema has been provided
        //
        assertInstanceType(ref[field], definition.constructor, ref as Schema, field);

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
    changeTree: ChangeTree,
    index: number,
    operation: OPERATION,
    it: Iterator,
) {
    const ref = changeTree.ref;
    const metadata = ref['constructor'][Symbol.metadata];

    const field = metadata[index];
    const type = metadata[field].type;
    const value = ref[field];

    // "compress" field index + operation
    bytes[it.offset++] = (index | operation) & 255;
    // encode.uint8(bytes, (index | operation), it);

    // // ensure refId for the value
    // if (value && value[$changes]) {
    //     value[$changes].ensureRefId();
    // }

    // TODO: inline this function call small performance gain
    encodeValue(encoder, bytes, ref, type, value, field, operation, it);
}

/**
 * Used for collections (MapSchema, ArraySchema, etc.)
 * @private
 */
export const encodeKeyValueOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: Buffer,
    changeTree: ChangeTree,
    field: number,
    operation: OPERATION,
    it: Iterator,
) {
    const ref = changeTree.ref;

    // encode field index + operation
    encode.uint8(bytes, operation, it);

    // custom operations
    if (operation === OPERATION.CLEAR) {
        return;
    }

    // indexed operations
    encode.number(bytes, field, it);

    //
    // encode "alias" for dynamic fields (maps)
    //
    if ((operation & OPERATION.ADD) == OPERATION.ADD) { // ADD or DELETE_AND_ADD
        if (typeof(ref['set']) === "function") {
            //
            // MapSchema dynamic key
            //
            const dynamicIndex = changeTree.ref['$indexes'].get(field);
            encode.string(bytes, dynamicIndex, it);
        }
    }

    if (operation === OPERATION.DELETE) {
        //
        // TODO: delete from filter cache data.
        //
        // if (useFilters) {
        //     delete changeTree.caches[fieldIndex];
        // }
        return;
    }

    const type = changeTree.getType(field);
    const value = changeTree.getValue(field);

    // // ensure refId for the value
    // if (value && value[$changes]) {
    //     value[$changes].ensureRefId();
    // }

    // console.log("ENCODE VALUE!", {
    //     ref: ref.constructor.name, type, value, field, operation
    // });

    // TODO: inline this function call small performance gain
    encodeValue(encoder, bytes, ref, type, value, field, operation, it);
}