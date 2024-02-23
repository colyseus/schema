import { OPERATION } from "../spec";
import { Metadata } from "../Metadata";
import { DataChange, Schema, SchemaDecoderCallbacks } from "../Schema";
import type { Ref } from "./ChangeTree";
import type { Decoder } from "../Decoder";
import * as decode from "../encoding/decode";
import { getType } from "../types/typeRegistry";
import { $childType, $deleteByIndex, $getByIndex } from "./consts";
import { ArraySchema, CollectionSchema, MapSchema, SetSchema } from "..";

export enum DecodeState {
    DEFINITION_MISMATCH = 0,
}

export type DecodeOperation<T extends Schema = any> = (
    decoder: Decoder<T>,
    bytes: number[],
    it: decode.Iterator,
    ref: Ref,
    allChanges: DataChange[],
) => DecodeState | void;

export function decodeValue(decoder: Decoder, operation: OPERATION, ref: Ref, index: number, type: any, bytes: number[], it: decode.Iterator, allChanges: DataChange[]) {
    const $root = decoder.refs;
    const previousValue = ref[$getByIndex](index);

    let value: any;

    if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
    {
        //
        // Delete operations
        //
        if (operation !== OPERATION.DELETE_AND_ADD) {
            ref[$deleteByIndex](index);
        }

        // Flag `refId` for garbage collection.
        const previousRefId = $root.refIds.get(previousValue);
        if (previousRefId) {
            $root.removeRef(previousRefId);
        }

        value = null;

    } else if (Schema.is(type)) {
        const refId = decode.number(bytes, it);
        value = $root.refs.get(refId);

        if (operation !== OPERATION.REPLACE) {
            const childType = decoder.getInstanceType(bytes, it, type);

            if (!value) {
                value = decoder.createInstanceOfType(childType);

                if (previousValue) {
                    // value.$callbacks = previousValue.$callbacks;
                    // value.$listeners = previousValue.$listeners;
                    const previousRefId = $root.refIds.get(previousValue);
                    if (previousRefId && refId !== previousRefId) {
                        $root.removeRef(previousRefId);
                    }
                }
            }

            // console.log("ADD REF!", refId, value, ", TYPE =>", Metadata.getFor(childType));
            $root.addRef(refId, value, (value !== previousValue));
        }

    } else if (typeof(type) === "string") {
        //
        // primitive value (number, string, boolean, etc)
        //
        value = decode[type as string](bytes, it);

    } else {
        const typeDef = getType(Object.keys(type)[0]);
        const refId = decode.number(bytes, it);

        const valueRef: SchemaDecoderCallbacks = ($root.refs.has(refId))
            ? previousValue || $root.refs.get(refId)
            : new typeDef.constructor();

        value = valueRef.clone(true);
        value[$childType] = Object.values(type)[0]; // cache childType for ArraySchema and MapSchema

        // preserve schema callbacks
        if (previousValue) {
            // value['$callbacks'] = previousValue['$callbacks'];
            const previousRefId = $root.refIds.get(previousValue);

            if (previousRefId && refId !== previousRefId) {
                $root.removeRef(previousRefId);

                //
                // Trigger onRemove if structure has been replaced.
                //
                const entries: IterableIterator<[any, any]> = previousValue.entries();
                let iter: IteratorResult<[any, any]>;
                while ((iter = entries.next()) && !iter.done) {
                    const [key, value] = iter.value;
                    allChanges.push({
                        refId,
                        op: OPERATION.DELETE,
                        field: key,
                        value: undefined,
                        previousValue: value,
                    });
                }

            }
        }

        // console.log("ADD REF!", { refId, value });
        $root.addRef(refId, value, (valueRef !== previousValue));
    }

    return { value, previousValue };
}

export const decodeSchemaOperation: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: number[],
    it: decode.Iterator,
    ref: Ref,
    allChanges: DataChange[]
) {
    const first_byte = bytes[it.offset++];
    const metadata: Metadata = ref['constructor'][Symbol.metadata];

    // "compressed" index + operation
    const operation = (first_byte >> 6) << 6
    const index = first_byte % (operation || 255);

    // skip early if field is not defined
    const field = metadata[index];
    if (field === undefined) {
        return DecodeState.DEFINITION_MISMATCH;
    }

    const { value, previousValue } = decodeValue(
        decoder,
        operation,
        ref,
        index,
        metadata[field].type,
        bytes,
        it,
        allChanges
    );

    if (value !== null && value !== undefined) {
        ref[field] = value;
    }

    // add change
    if (previousValue !== value) {
        allChanges.push({
            refId: decoder.currentRefId,
            op: operation,
            field: field,
            value,
            previousValue,
        });
    }
}

export const decodeKeyValueOperation: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: number[],
    it: decode.Iterator,
    ref: Ref,
    allChanges: DataChange[]
) {
    const first_byte = bytes[it.offset++];

    // "uncompressed" index + operation (array/map items)
    const operation = first_byte;

    if (operation === OPERATION.CLEAR) {
        //
        // TODO: refactor me!
        // The `.clear()` method is calling `$root.removeRef(refId)` for
        // each item inside this collection
        //
        (ref as SchemaDecoderCallbacks).clear(allChanges);
        return;
    }

    const index = decode.number(bytes, it);
    const type = ref[$childType];

    let dynamicIndex: number | string;

    if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
        dynamicIndex = (ref instanceof MapSchema)
            ? decode.string(bytes, it)
            : index;
        ref['setIndex'](index, dynamicIndex);

    } else {
        dynamicIndex = ref['getIndex'](index);
    }

    const { value, previousValue } = decodeValue(
        decoder,
        operation,
        ref,
        dynamicIndex as number,
        type,
        bytes,
        it,
        allChanges
    );

    if (value !== null && value !== undefined) {
        if (ref instanceof MapSchema) {
            // const key = ref['$indexes'].get(field);
            const key = dynamicIndex as string;

            // ref.set(key, value);
            ref['$items'].set(key, value);

        } else if (ref instanceof ArraySchema) {
            // const key = ref['$indexes'][field];
            // console.log("SETTING FOR ArraySchema =>", { field, key, value });
            // ref[key] = value;
            ref.setAt(index, value);

        } else if (ref instanceof CollectionSchema) {
            const index = ref.add(value);
            ref['setIndex'](index, index);

        } else if (ref instanceof SetSchema) {
            const index = ref.add(value);
            if (index !== false) {
                ref['setIndex'](index, index);
            }
        }
    }

    // add change
    if (previousValue !== value) {
        allChanges.push({
            refId: decoder.currentRefId,
            op: operation,
            field: "", // FIXME: remove this
            dynamicIndex,
            value,
            previousValue,
        });
    }
}