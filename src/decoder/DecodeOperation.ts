import { OPERATION } from "../encoding/spec";
import { Metadata } from "../Metadata";
import { Schema } from "../Schema";
import type { Ref } from "../encoder/ChangeTree";
import type { Decoder } from "./Decoder";
import { Iterator, decode } from "../encoding/decode";
import { $childType, $deleteByIndex, $getByIndex } from "../types/symbols";

import type { MapSchema } from "../types/custom/MapSchema";
import type { ArraySchema } from "../types/custom/ArraySchema";
import type { CollectionSchema } from "../types/custom/CollectionSchema";

import { getType } from "../types/registry";
import { Collection } from "../types/HelperTypes";

export interface DataChange<T = any, F = string> {
    ref: Ref,
    refId: number,
    op: OPERATION,
    field: F;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

export const DEFINITION_MISMATCH = -1;

export type DecodeOperation<T extends Schema = any> = (
    decoder: Decoder<T>,
    bytes: Buffer,
    it: Iterator,
    ref: Ref,
    allChanges: DataChange[],
) => number | void;

export function decodeValue(
    decoder: Decoder,
    operation: OPERATION,
    ref: Ref,
    index: number,
    type: any,
    bytes: Buffer,
    it: Iterator,
    allChanges: DataChange[],
) {
    const $root = decoder.root;
    const previousValue = ref[$getByIndex](index);

    let value: any;

    if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
    {
        // Flag `refId` for garbage collection.
        const previousRefId = $root.refIds.get(previousValue);
        if (previousRefId !== undefined) { $root.removeRef(previousRefId); }

        //
        // Delete operations
        //
        if (operation !== OPERATION.DELETE_AND_ADD) {
            ref[$deleteByIndex](index);
        }

        value = undefined;
    }

    if (operation === OPERATION.DELETE) {
        //
        // Don't do anything
        //

    } else if (Schema.is(type)) {
        const refId = decode.number(bytes, it);
        value = $root.refs.get(refId);

        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            const childType = decoder.getInstanceType(bytes, it, type);
            if (!value) {
                value = decoder.createInstanceOfType(childType);
            }

            $root.addRef(
                refId,
                value,
                (
                    value !== previousValue || // increment ref count if value has changed
                    (operation === OPERATION.DELETE_AND_ADD && value === previousValue) // increment ref count if the same instance is being added again
                )
            );
        }

    } else if (typeof(type) === "string") {
        //
        // primitive value (number, string, boolean, etc)
        //
        value = decode[type as string](bytes, it);

    } else {
        const typeDef = getType(Object.keys(type)[0]);
        const refId = decode.number(bytes, it);

        const valueRef: Ref = ($root.refs.has(refId))
            ? previousValue || $root.refs.get(refId)
            : new typeDef.constructor();

        value = valueRef.clone(true);
        value[$childType] = Object.values(type)[0]; // cache childType for ArraySchema and MapSchema

        if (previousValue) {
            let previousRefId = $root.refIds.get(previousValue);

            if (previousRefId !== undefined && refId !== previousRefId) {
                //
                // enqueue onRemove if structure has been replaced.
                //
                const entries: IterableIterator<[any, any]> = previousValue.entries();
                let iter: IteratorResult<[any, any]>;
                while ((iter = entries.next()) && !iter.done) {
                    const [key, value] = iter.value;

                    // if value is a schema, remove its reference
                    // FIXME: not sure if this is necessary, add more tests to confirm
                    if (typeof(value) === "object") {
                        previousRefId = $root.refIds.get(value);
                        $root.removeRef(previousRefId);
                    }

                    allChanges.push({
                        ref: previousValue,
                        refId: previousRefId,
                        op: OPERATION.DELETE,
                        field: key,
                        value: undefined,
                        previousValue: value,
                    });
                }

            }
        }

        $root.addRef(refId, value, (
            valueRef !== previousValue ||
            (operation === OPERATION.DELETE_AND_ADD && valueRef === previousValue)
        ));
    }

    return { value, previousValue };
}

export const decodeSchemaOperation: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: Buffer,
    it: Iterator,
    ref: Ref,
    allChanges: DataChange[],
) {
    const first_byte = bytes[it.offset++];
    const metadata: Metadata = ref.constructor[Symbol.metadata];

    // "compressed" index + operation
    const operation = (first_byte >> 6) << 6
    const index = first_byte % (operation || 255);

    // skip early if field is not defined
    const field = metadata[index];
    if (field === undefined) {
        console.warn("@colyseus/schema: field not defined at", { index, ref: ref.constructor.name, metadata });
        return DEFINITION_MISMATCH;
    }

    const { value, previousValue } = decodeValue(
        decoder,
        operation,
        ref,
        index,
        field.type,
        bytes,
        it,
        allChanges,
    );

    if (value !== null && value !== undefined) {
        ref[field.name] = value;
    }

    // add change
    if (previousValue !== value) {
        allChanges.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            field: field.name,
            value,
            previousValue,
        });
    }
}

export const decodeKeyValueOperation: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: Buffer,
    it: Iterator,
    ref: Ref,
    allChanges: DataChange[]
) {
    // "uncompressed" index + operation (array/map items)
    const operation = bytes[it.offset++];

    if (operation === OPERATION.CLEAR) {
        //
        // When decoding:
        // - enqueue items for DELETE callback.
        // - flag child items for garbage collection.
        //
        decoder.removeChildRefs(ref as unknown as Collection, allChanges);

        (ref as any).clear();
        return;
    }

    const index = decode.number(bytes, it);
    const type = ref[$childType];

    let dynamicIndex: number | string;

    if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
        if (typeof(ref['set']) === "function") {
            dynamicIndex = decode.string(bytes, it); // MapSchema
            ref['setIndex'](index, dynamicIndex);
        } else {
            dynamicIndex = index; // ArraySchema
        }
    } else {
        // get dynamic index from "ref"
        dynamicIndex = ref['getIndex'](index);
    }


    const { value, previousValue } = decodeValue(
        decoder,
        operation,
        ref,
        index,
        type,
        bytes,
        it,
        allChanges,
    );

    if (value !== null && value !== undefined) {
        if (typeof(ref['set']) === "function") {
            // MapSchema
            (ref as MapSchema)['$items'].set(dynamicIndex as string, value);

        } else if (typeof(ref['$setAt']) === "function") {
            // ArraySchema
            (ref as ArraySchema)['$setAt'](index, value, operation);

        } else if (typeof(ref['add']) === "function") {
            // CollectionSchema && SetSchema
            const index = (ref as CollectionSchema).add(value);

            if (typeof(index) === "number") {
                ref['setIndex'](index, index);
            }
        }
    }

    // add change
    if (previousValue !== value) {
        allChanges.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            field: "", // FIXME: remove this
            dynamicIndex,
            value,
            previousValue,
        });
    }
}

export const decodeArray: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: Buffer,
    it: Iterator,
    ref: ArraySchema,
    allChanges: DataChange[]
) {
    // "uncompressed" index + operation (array/map items)
    let operation = bytes[it.offset++];
    let index: number;

    if (operation === OPERATION.CLEAR) {
        //
        // When decoding:
        // - enqueue items for DELETE callback.
        // - flag child items for garbage collection.
        //
        decoder.removeChildRefs(ref as unknown as Collection, allChanges);
        (ref as ArraySchema).clear();
        return;

    } else if (operation === OPERATION.REVERSE) {
        (ref as ArraySchema).reverse();
        return;

    } else if (operation === OPERATION.DELETE_BY_REFID) {
        // TODO: refactor here, try to follow same flow as below
        const refId = decode.number(bytes, it);
        const previousValue = decoder.root.refs.get(refId);
        index = ref.findIndex((value) => value === previousValue);
        ref[$deleteByIndex](index);
        allChanges.push({
            ref,
            refId: decoder.currentRefId,
            op: OPERATION.DELETE,
            field: "", // FIXME: remove this
            dynamicIndex: index,
            value: undefined,
            previousValue,
        });

        return;

    } else if (operation === OPERATION.ADD_BY_REFID) {
        const refId = decode.number(bytes, it);
        const itemByRefId = decoder.root.refs.get(refId);

        // use existing index, or push new value
        index = (itemByRefId)
            ? ref.findIndex((value) => value === itemByRefId)
            : ref.length;

    } else {
        index = decode.number(bytes, it);
    }

    const type = ref[$childType];

    let dynamicIndex: number | string = index;

    const { value, previousValue } = decodeValue(
        decoder,
        operation,
        ref,
        index,
        type,
        bytes,
        it,
        allChanges,
    );

    if (
        value !== null && value !== undefined &&
        value !== previousValue // avoid setting same value twice (if index === 0 it will result in a "unshift" for ArraySchema)
    ) {
        // ArraySchema
        (ref as ArraySchema)['$setAt'](index, value, operation);
    }

    // add change
    if (previousValue !== value) {
        allChanges.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            field: "", // FIXME: remove this
            dynamicIndex,
            value,
            previousValue,
        });
    }
}