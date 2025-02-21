import { TypeContext } from "../types/TypeContext";
import { $changes, $childType, $decoder, $onDecodeEnd } from "../types/symbols";
import { Schema } from "../Schema";

import { decode } from "../encoding/decode";
import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec';
import type { Ref } from "../encoder/ChangeTree";
import type { Iterator } from "../encoding/decode";
import { ReferenceTracker } from "./ReferenceTracker";
import { DEFINITION_MISMATCH, type DataChange, type DecodeOperation } from "./DecodeOperation";
import { Collection } from "../types/HelperTypes";

export class Decoder<T extends Schema = any> {
    context: TypeContext;

    state: T;
    root: ReferenceTracker;

    currentRefId: number = 0;

    triggerChanges?: (allChanges: DataChange[]) => void;

    constructor(root: T, context?: TypeContext) {
        this.setState(root);

        this.context = context || new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Decoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setState(root: T) {
        this.state = root;
        this.root = new ReferenceTracker();
        this.root.addRef(0, root);
    }

    decode(
        bytes: Buffer,
        it: Iterator = { offset: 0 },
        ref: Ref = this.state,
    ) {
        const allChanges: DataChange[] = [];

        const $root = this.root;
        const totalBytes = bytes.byteLength;

        let decoder: DecodeOperation = ref['constructor'][$decoder];

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
                ref[$onDecodeEnd]?.()
                ref = nextRef;

                decoder = ref.constructor[$decoder];

                continue;
            }

            const result = decoder(this, bytes, it, ref, allChanges);

            if (result === DEFINITION_MISMATCH) {
                console.warn("@colyseus/schema: definition mismatch");

                //
                // keep skipping next bytes until reaches a known structure
                // by local decoder.
                //
                const nextIterator: Iterator = { offset: it.offset };
                while (it.offset < totalBytes) {
                    if (bytes[it.offset] === SWITCH_TO_STRUCTURE) {
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

        // FIXME: DRY with SWITCH_TO_STRUCTURE block.
        ref[$onDecodeEnd]?.()

        // trigger changes
        this.triggerChanges?.(allChanges);

        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();

        return allChanges;
    }

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

    removeChildRefs(ref: Collection, allChanges: DataChange[]) {
        const needRemoveRef = typeof (ref[$childType]) !== "string";
        const refId = this.root.refIds.get(ref as Ref);

        ref.forEach((value: any, key: any) => {
            allChanges.push({
                ref: ref as Ref,
                refId,
                op: OPERATION.DELETE,
                field: key,
                value: undefined,
                previousValue: value
            });

            if (needRemoveRef) {
                this.root.removeRef(this.root.refIds.get(value));
            }
        });
    }

}

