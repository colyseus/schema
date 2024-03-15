import { Metadata } from "../Metadata";
import { TypeContext } from "../annotations";
import { $childType, $decoder } from "../types/symbols";
import { DataChange, Schema, SchemaDecoderCallbacks } from "../Schema";
import { CollectionSchema } from "../types/CollectionSchema";
import { MapSchema } from "../types/MapSchema";
import { SetSchema } from "../types/SetSchema";
import { ArraySchema } from "../types/ArraySchema";

import * as decode from "../encoding/decode";
import { getType } from '../types/typeRegistry';
import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from '../encoding/spec';
import { Ref } from "../encoder/ChangeTree";
import { Iterator } from "../encoding/decode";
import { ReferenceTracker } from "./ReferenceTracker";
import { DecodeState } from "./DecodeOperation";

export class Decoder<T extends Schema = any> {
    context: TypeContext;

    state: T;
    refs: ReferenceTracker;

    currentRefId: number = 0;

    constructor(root: T, context?: TypeContext) {
        this.setRoot(root);
        this.context = context || new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Decoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(root: T) {
        this.state = root;
        this.refs = new ReferenceTracker();
        this.refs.addRef(0, root);
    }

    decode(
        bytes: Buffer,
        it: Iterator = { offset: 0 },
        ref: Ref = this.state,
    ) {
        const allChanges: DataChange[] = [];

        const $root = this.refs;
        const totalBytes = bytes.byteLength;

        this.currentRefId = 0;

        while (it.offset < totalBytes) {
            //
            // Peek ahead, check if it's a switch to a different structure
            //
            if (bytes[it.offset] == SWITCH_TO_STRUCTURE) {
                it.offset++;

                this.currentRefId = decode.number(bytes, it);
                const nextRef = $root.refs.get(this.currentRefId) as Schema;

                //
                // Trying to access a reference that haven't been decoded yet.
                //
                if (!nextRef) { throw new Error(`"refId" not found: ${this.currentRefId}`); }
                ref = nextRef;

                continue;
            }

            const decoder = ref['constructor'][$decoder];
            const result = decoder(this, bytes, it, ref, allChanges);

            if (result === DecodeState.DEFINITION_MISMATCH) {
                console.warn("@colyseus/schema: definition mismatch");

                //
                // keep skipping next bytes until reaches a known structure
                // by local decoder.
                //
                const nextIterator: decode.Iterator = { offset: it.offset };
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
            }
        }

        // FIXME: trigger callbacks
        // this._triggerChanges(allChanges);

        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();

        return allChanges;
    }

    /*
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
    */

    getInstanceType(bytes: Buffer, it: Iterator, defaultType: typeof Schema): typeof Schema {
        let type: typeof Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const type_id = decode.number(bytes, it);
            type = this.context.get(type_id);
        }

        return type || defaultType;
    }

    createInstanceOfType (type: typeof Schema): Schema {
        // let instance: Schema = new (type as any)();

        // // assign root on $changes
        // instance[$changes].root = this.root[$changes].root;

        // return instance;
        return new (type as any)();
    }

}

