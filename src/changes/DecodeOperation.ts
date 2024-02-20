import { Metadata } from "..";
import type { Decoder } from "../Decoder";
import { OPERATION } from "../spec";
import type { Ref } from "./ChangeTree";
import * as decode from "../encoding/decode";

export type DecodeOperation<T extends Ref = any> = (
    decoder: Decoder<any>,
    bytes: number[],
    it: decode.Iterator,
    ref: Ref,
    index: number,
) => void;

export const decodeSchemaOperation: DecodeOperation = function () {
    const metadata: Metadata = (isSchema) ? ref['constructor'][Symbol.metadata] : undefined;

    const operation = (isSchema)
        ? (byte >> 6) << 6 // "compressed" index + operation
        : byte; // "uncompressed" index + operation (array/map items)

    if (operation === OPERATION.CLEAR) {
        //
        // TODO: refactor me!
        // The `.clear()` method is calling `$root.removeRef(refId)` for
        // each item inside this collection
        //
        (ref as SchemaDecoderCallbacks).clear(allChanges);
        continue;
    }

    const fieldIndex = (isSchema)
        ? byte % (operation || 255) // if "REPLACE" operation (0), use 255
        : decode.number(bytes, it);

    const fieldName = (isSchema)
        ? metadata[fieldIndex]
        : "";

    const type = (isSchema)
        ? metadata[fieldName].type
        : ref[$childType];

    let value: any;
    let previousValue: any;

    let dynamicIndex: number | string;

    if (!isSchema) {
        previousValue = ref['getByIndex'](fieldIndex);

        if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
            dynamicIndex = (ref instanceof MapSchema)
                ? decode.string(bytes, it)
                : fieldIndex;
            ref['setIndex'](fieldIndex, dynamicIndex);

        } else {
            // here
            dynamicIndex = ref['getIndex'](fieldIndex);
        }

    } else {
        previousValue = ref[fieldName];
    }

    //
    // Delete operations
    //
    if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
    {
        if (operation !== OPERATION.DELETE_AND_ADD) {
            ref['deleteByIndex'](fieldIndex);
        }

        // Flag `refId` for garbage collection.
        const previousRefId = $root.refIds.get(previousValue);
        if (previousRefId) {
            $root.removeRef(previousRefId);
        }

        value = null;
    }

    // console.log("decoding (1)...", {  ref, refId, isSchema, fieldName, fieldIndex, operation,});
    // console.log("decoding...", { refId, fieldName, fieldIndex });

    if (fieldName === undefined) {
        console.warn("@colyseus/schema: definition mismatch");

        //
        // keep skipping next bytes until reaches a known structure
        // by local decoder.
        //
        const nextIterator: Iterator = { offset: it.offset };
        while (it.offset < totalBytes) {
            if (decode.switchStructureCheck(bytes, it)) {
                nextIterator.offset = it.offset + 1;
                if ($root.refs.has(decode.number(bytes, nextIterator))) {
                    break;
                }
            }

            it.offset++;
        }

        continue;

    } else if (operation === OPERATION.DELETE) {
        //
        // FIXME: refactor me.
        // Don't do anything.
        //

    } else if (Schema.is(type)) {
        const refId = decode.number(bytes, it);
        value = $root.refs.get(refId);

        // console.log({
        //     refId,
        //     value,
        //     operation: OPERATION[operation],
        // });

        if (operation !== OPERATION.REPLACE) {
            const childType = this.getSchemaType(bytes, it, type);

            if (!value) {
                value = this.createTypeInstance(childType);

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

    if (
        value !== null &&
        value !== undefined
    ) {

        if (ref instanceof Schema) {
            ref[fieldName] = value;

        } else if (ref instanceof MapSchema) {
            // const key = ref['$indexes'].get(field);
            const key = dynamicIndex as string;

            // ref.set(key, value);
            ref['$items'].set(key, value);

        } else if (ref instanceof ArraySchema) {
            // const key = ref['$indexes'][field];
            // console.log("SETTING FOR ArraySchema =>", { field, key, value });
            // ref[key] = value;
            ref.setAt(fieldIndex, value);

        } else if (ref instanceof CollectionSchema) {
            const index = ref.add(value);
            ref['setIndex'](fieldIndex, index);

        } else if (ref instanceof SetSchema) {
            const index = ref.add(value);
            if (index !== false) {
                ref['setIndex'](fieldIndex, index);
            }
        }
    }

}

export const decodeKeyValueOperation: DecodeOperation = function () {
    const metadata: Metadata = (isSchema) ? ref['constructor'][Symbol.metadata] : undefined;

    const operation = (isSchema)
        ? (byte >> 6) << 6 // "compressed" index + operation
        : byte; // "uncompressed" index + operation (array/map items)

    if (operation === OPERATION.CLEAR) {
        //
        // TODO: refactor me!
        // The `.clear()` method is calling `$root.removeRef(refId)` for
        // each item inside this collection
        //
        (ref as SchemaDecoderCallbacks).clear(allChanges);
        continue;
    }

    const fieldIndex = (isSchema)
        ? byte % (operation || 255) // if "REPLACE" operation (0), use 255
        : decode.number(bytes, it);

    const fieldName = (isSchema)
        ? metadata[fieldIndex]
        : "";

    const type = (isSchema)
        ? metadata[fieldName].type
        : ref[$childType];

    let value: any;
    let previousValue: any;

    let dynamicIndex: number | string;

    if (!isSchema) {
        previousValue = ref['getByIndex'](fieldIndex);

        if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
            dynamicIndex = (ref instanceof MapSchema)
                ? decode.string(bytes, it)
                : fieldIndex;
            ref['setIndex'](fieldIndex, dynamicIndex);

        } else {
            // here
            dynamicIndex = ref['getIndex'](fieldIndex);
        }

    } else {
        previousValue = ref[fieldName];
    }

    //
    // Delete operations
    //
    if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
    {
        if (operation !== OPERATION.DELETE_AND_ADD) {
            ref['deleteByIndex'](fieldIndex);
        }

        // Flag `refId` for garbage collection.
        const previousRefId = $root.refIds.get(previousValue);
        if (previousRefId) {
            $root.removeRef(previousRefId);
        }

        value = null;
    }

    // console.log("decoding (1)...", {  ref, refId, isSchema, fieldName, fieldIndex, operation,});
    // console.log("decoding...", { refId, fieldName, fieldIndex });

    if (fieldName === undefined) {
        console.warn("@colyseus/schema: definition mismatch");

        //
        // keep skipping next bytes until reaches a known structure
        // by local decoder.
        //
        const nextIterator: Iterator = { offset: it.offset };
        while (it.offset < totalBytes) {
            if (decode.switchStructureCheck(bytes, it)) {
                nextIterator.offset = it.offset + 1;
                if ($root.refs.has(decode.number(bytes, nextIterator))) {
                    break;
                }
            }

            it.offset++;
        }

        continue;

    } else if (operation === OPERATION.DELETE) {
        //
        // FIXME: refactor me.
        // Don't do anything.
        //

    } else if (Schema.is(type)) {
        const refId = decode.number(bytes, it);
        value = $root.refs.get(refId);

        // console.log({
        //     refId,
        //     value,
        //     operation: OPERATION[operation],
        // });

        if (operation !== OPERATION.REPLACE) {
            const childType = this.getSchemaType(bytes, it, type);

            if (!value) {
                value = this.createTypeInstance(childType);

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

    if (
        value !== null &&
        value !== undefined
    ) {

        if (ref instanceof Schema) {
            ref[fieldName] = value;

        } else if (ref instanceof MapSchema) {
            // const key = ref['$indexes'].get(field);
            const key = dynamicIndex as string;

            // ref.set(key, value);
            ref['$items'].set(key, value);

        } else if (ref instanceof ArraySchema) {
            // const key = ref['$indexes'][field];
            // console.log("SETTING FOR ArraySchema =>", { field, key, value });
            // ref[key] = value;
            ref.setAt(fieldIndex, value);

        } else if (ref instanceof CollectionSchema) {
            const index = ref.add(value);
            ref['setIndex'](fieldIndex, index);

        } else if (ref instanceof SetSchema) {
            const index = ref.add(value);
            if (index !== false) {
                ref['setIndex'](fieldIndex, index);
            }
        }
    }

}