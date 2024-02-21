import { OPERATION } from "../spec";
import { $changes } from "./consts";
import { getType } from "../types/typeRegistry";

import * as encode from "../encoding/encode";
import { EncodeSchemaError, assertInstanceType, assertType } from "../encoding/assert";

import type { ChangeTracker, Ref } from "./ChangeTree";
import type { Encoder } from "../Encoder";
import type { Schema } from "../Schema";
import type { PrimitiveType } from "../annotations";

import { MapSchema } from "../types/MapSchema";

export type EncodeOperation<T extends Ref = any> = (
    encoder: Encoder,
    bytes: number[],
    changeTree: ChangeTracker<T>,
    index: number,
    operation: OPERATION,
) => void;

export function encodePrimitiveType(
    type: PrimitiveType,
    bytes: number[],
    value: any,
    klass: Schema,
    field: string | number,
) {
    assertType(value, type as string, klass, field);

    const encodeFunc = encode[type as string];

    if (encodeFunc) {
        encodeFunc(bytes, value);

    } else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}

export function encodeValue(
    encoder: Encoder,
    bytes: number[],
    ref: Schema,
    type: any,
    value: any,
    field: string | number,
    operation: OPERATION
) {
    if (type[Symbol.metadata] !== undefined) {
        assertInstanceType(value, type as typeof Schema, ref as Schema, field);

        //
        // Encode refId for this instance.
        // The actual instance is going to be encoded on next `changeTree` iteration.
        //
        encode.number(bytes, value[$changes].refId);

        // Try to encode inherited TYPE_ID if it's an ADD operation.
        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            encoder.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);
        }

    } else if (typeof (type) === "string") {
        //
        // Primitive values
        //
        encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, field);

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
        encode.number(bytes, value[$changes].refId);
    }
}

/**
 * Used for Schema instances.
 * @private
 */
export const encodeSchemaOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: number[],
    changeTree: ChangeTracker,
    index: number,
    operation: OPERATION,
) {
    const ref = changeTree.ref;
    const metadata = ref['constructor'][Symbol.metadata];

    const field = metadata[index];
    const type = metadata[field].type;
    const value = ref[field];

    // "compress" field index + operation
    encode.uint8(bytes, (index | operation));

    // ensure refId for the value
    if (value && value[$changes]) {
        value[$changes].ensureRefId();
    }

    if (operation === OPERATION.TOUCH) {
        return;
    }

    // TODO: inline this function call small performance gain
    encodeValue(encoder, bytes, ref, type, value, field, operation);
}

/**
 * Used for collections (MapSchema, ArraySchema, etc.)
 * @private
 */
export const encodeKeyValueOperation: EncodeOperation = function (
    encoder: Encoder,
    bytes: number[],
    changeTree: ChangeTracker,
    field: number,
    operation: OPERATION,
) {
    const ref = changeTree.ref;

    // encode field index + operation
    if (operation !== OPERATION.TOUCH) {
        encode.uint8(bytes, operation);

        // custom operations
        if (operation === OPERATION.CLEAR) {
            return;
        }

        // indexed operations
        encode.number(bytes, field);
    }

    //
    // encode "alias" for dynamic fields (maps)
    //
    if ((operation & OPERATION.ADD) == OPERATION.ADD) { // ADD or DELETE_AND_ADD
        if (ref instanceof MapSchema) {
            //
            // MapSchema dynamic key
            //
            const dynamicIndex = changeTree.ref['$indexes'].get(field);
            encode.string(bytes, dynamicIndex);
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

    // ensure refId for the value
    if (value && value[$changes]) {
        value[$changes].ensureRefId();
    }

    if (operation === OPERATION.TOUCH) {
        return;
    }

    // TODO: inline this function call small performance gain
    encodeValue(encoder, bytes, ref, type, value, field, operation);
}