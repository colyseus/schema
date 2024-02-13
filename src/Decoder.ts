import { TypeContext, DefinitionType, PrimitiveType, Metadata } from "./annotations";
import { DataChange, Schema, SchemaDecoderCallbacks } from "./Schema";
import { CollectionSchema } from "./types/CollectionSchema";
import { MapSchema } from "./types/MapSchema";
import { SetSchema } from "./types/SetSchema";
import { ArraySchema } from "./types/ArraySchema";

import * as decode from "./encoding/decode";
import { getType } from './types/typeRegistry';
import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTree, Ref } from "./changes/ChangeTree";
import { Iterator } from "./encoding/decode";
import { ReferenceTracker } from "./changes/ReferenceTracker";

function decodePrimitiveType (type: string, bytes: number[], it: Iterator) {
    return decode[type as string](bytes, it);
}

export class Decoder<T extends Schema> {
    context: TypeContext;

    root: T;
    refs: ReferenceTracker;

    constructor(root: T, context?: TypeContext) {
        this.setRoot(root);
        this.context = context || new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Decoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(root: T) {
        this.root = root;
        this.refs = new ReferenceTracker();
        this.refs.addRef(0, root);
    }

    decode(
        bytes: number[],
        it: Iterator = { offset: 0 },
        ref: Ref = this.root,
    ) {
        // console.log("------------------- DECODE -------------------");
        const allChanges: DataChange[] = [];

        const $root = this.refs;
        const totalBytes = bytes.length;

        let refId: number = 0;

        while (it.offset < totalBytes) {
            let byte = bytes[it.offset++];

            if (byte == SWITCH_TO_STRUCTURE) {
                refId = decode.number(bytes, it);
                const nextRef = $root.refs.get(refId) as Schema;

                //
                // Trying to access a reference that haven't been decoded yet.
                //
                if (!nextRef) { throw new Error(`"refId" not found: ${refId}`); }
                ref = nextRef;

                continue;
            }

            const isSchema = (ref instanceof Schema);
            const metadata = (isSchema) ? Metadata.getFor(ref['constructor']) : undefined;

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
                ? metadata.fieldsByIndex[fieldIndex]
                : "";

            const type = (isSchema)
                ? Metadata.getType(metadata, fieldName)
                : ref['$changes'].getType(); // FIXME: refactor me.

            let value: any;
            let previousValue: any;

            let dynamicIndex: number | string;

            // console.log({ isSchema, fieldIndex, fieldName, type });

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
                value = decodePrimitiveType(type as string, bytes, it);

            } else {
                const typeDef = getType(Object.keys(type)[0]);
                const refId = decode.number(bytes, it);

                const valueRef: SchemaDecoderCallbacks = ($root.refs.has(refId))
                    ? previousValue || $root.refs.get(refId)
                    : new typeDef.constructor();

                value = valueRef.clone(true);

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

            if (previousValue !== value) {
                allChanges.push({
                    refId,
                    op: operation,
                    field: fieldName,
                    dynamicIndex,
                    value,
                    previousValue,
                });
            }
        }

        // FIXME: trigger callbacks
        // this._triggerChanges(allChanges);

        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();

        return allChanges;
    }

    private _triggerChanges(changes: DataChange[]) {
        const uniqueRefIds = new Set<number>();
        const $refs = this.refs.refs;

        for (let i = 0; i < changes.length; i++) {
            const change = changes[i];
            const refId = change.refId;
            const ref = $refs.get(refId);
            const $callbacks: Schema['$callbacks'] | SchemaDecoderCallbacks['$callbacks'] = ref['$callbacks'];

            //
            // trigger onRemove on child structure.
            //
            if (
                (change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                change.previousValue instanceof Schema
            ) {
                change.previousValue['$callbacks']?.[OPERATION.DELETE]?.forEach(callback => callback());
            }

            // no callbacks defined, skip this structure!
            if (!$callbacks) { continue; }

            if (ref instanceof Schema) {
                if (!uniqueRefIds.has(refId)) {
                    try {
                        // trigger onChange
                        ($callbacks as Schema['$callbacks'])?.[OPERATION.REPLACE]?.forEach(callback =>
                            callback());

                    } catch (e) {
                        Schema.onError(e);
                    }
                }

                try {
                    if ($callbacks.hasOwnProperty(change.field)) {
                        $callbacks[change.field]?.forEach((callback) =>
                            callback(change.value, change.previousValue));
                    }

                } catch (e) {
                    Schema.onError(e);
                }

            } else {
                // is a collection of items

                if (change.op === OPERATION.ADD && change.previousValue === undefined) {
                    // triger onAdd
                    $callbacks[OPERATION.ADD]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));

                } else if (change.op === OPERATION.DELETE) {
                    //
                    // FIXME: `previousValue` should always be available.
                    // ADD + DELETE operations are still encoding DELETE operation.
                    //
                    if (change.previousValue !== undefined) {
                        // triger onRemove
                        $callbacks[OPERATION.DELETE]?.forEach(callback =>
                            callback(change.previousValue, change.dynamicIndex ?? change.field));
                    }

                } else if (change.op === OPERATION.DELETE_AND_ADD) {
                    // triger onRemove
                    if (change.previousValue !== undefined) {
                        $callbacks[OPERATION.DELETE]?.forEach(callback =>
                            callback(change.previousValue, change.dynamicIndex ?? change.field));
                    }

                    // triger onAdd
                    $callbacks[OPERATION.ADD]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));
                }

                // trigger onChange
                if (change.value !== change.previousValue) {
                    $callbacks[OPERATION.REPLACE]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));
                }
            }

            uniqueRefIds.add(refId);
        }

    }

    private getSchemaType(bytes: number[], it: Iterator, defaultType: typeof Schema): typeof Schema {
        let type: typeof Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const type_id = decode.number(bytes, it);
            type = this.context.get(type_id);
        }

        return type || defaultType;
    }

    private createTypeInstance (type: typeof Schema): Schema {
        // let instance: Schema = new (type as any)();

        // // assign root on $changes
        // instance['$changes'].root = this.root['$changes'].root;

        // return instance;
        return new (type as any)();
    }

}

