import type { Schema } from "./Schema";
import { TypeContext } from "./annotations";
import { $changes, $encoder } from "./changes/consts";

import * as encode from "./encoding/encode";
import type { Iterator } from "./encoding/decode";

import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTree, Root } from "./changes/ChangeTree";
import { getNextPowerOf2 } from "./utils";

export class Encoder<T extends Schema = any> {
    context: TypeContext;

    root: T;
    $root: Root;

    sharedBuffer = Buffer.allocUnsafeSlow(8 * 1024); // 8KB
    // sharedBuffer = Buffer.allocUnsafeSlow(32); // 8KB

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for each new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Encoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(root: T) {
        this.$root = new Root();
        this.root = root;
        root[$changes].setRoot(this.$root);
    }

    encode(
        encodeAll = false,
        // bytes: number[] = [],
        // useFilters: boolean = false,
    ) {
        const it: Iterator = { offset: 0 };

        const bytes = this.sharedBuffer;
        const rootChangeTree = this.root[$changes];

        const changeTrees: ChangeTree[] = this.$root.changes;
        const numChangeTrees = changeTrees.length;

        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;

            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();

            // root `refId` is skipped.
            if (
                changeTree !== rootChangeTree &&
                (changeTree.changed || encodeAll)
            ) {
                encode.uint8(bytes, SWITCH_TO_STRUCTURE, it);
                encode.uint8(bytes, changeTree.refId, it);
            }

            const changes: IterableIterator<ChangeOperation | number> = (encodeAll)
                ? changeTree.allChanges.values()
                : changeTree.changes.values();

            let change: IteratorResult<ChangeOperation | number>;
            while (!(change = changes.next()).done) {
                const operation = (encodeAll)
                    ? OPERATION.ADD
                    : change.value.op;

                const fieldIndex = (encodeAll)
                    ? change.value
                    : change.value.index;

                const encoder = ref['constructor'][$encoder];
                encoder(this, bytes, changeTree, fieldIndex, operation, it);
            }

            // //
            // // skip encoding if buffer overflow is detected.
            // // the buffer will be resized and re-encoded.
            // //
            // if (it.offset > bytes.byteLength) {
            //     break;
            // }

        }

        if (it.offset > bytes.byteLength) {
            const newSize = getNextPowerOf2(it.offset);
            console.debug("@colyseus/schema encode buffer overflow. Current buffer size: " + bytes.byteLength + ", encoding offset: " + it.offset + ", new size: " + newSize);

            // resize buffer
            this.sharedBuffer = Buffer.allocUnsafeSlow(newSize);
            return this.encode(encodeAll);

        } else {
            //
            // only clear changes after making sure buffer resize is not required.
            //
            if (!encodeAll) {
                for (let i = 0; i < numChangeTrees; i++) {
                    changeTrees[i].discard();
                }
            }

            // return bytes;
            return new DataView(bytes.buffer, 0, it.offset);
        }
    }

    encodeAll (useFilters?: boolean) {
        return this.encode(true);
    }

    tryEncodeTypeId (bytes: Buffer, baseType: typeof Schema, targetType: typeof Schema, it: Iterator) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        if (baseTypeId !== targetTypeId) {
            encode.uint8(bytes, TYPE_ID, it);
            encode.number(bytes, targetTypeId, it);
        }
    }
}