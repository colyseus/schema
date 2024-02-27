import type { Schema } from "./Schema";
import { TypeContext } from "./annotations";
import { $changes, $encoder, $filter } from "./changes/consts";

import * as encode from "./encoding/encode";
import type { Iterator } from "./encoding/decode";

import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTree, Root } from "./changes/ChangeTree";
import { getNextPowerOf2 } from "./utils";
import { StateView } from "./filters/StateView";

type FilteredOperation = ChangeOperation & { changeTree: ChangeTree };

export class Encoder<T extends Schema = any> {
    context: TypeContext;

    root: T;
    $root: Root;

    sharedBuffer = Buffer.allocUnsafeSlow(8 * 1024); // 8KB
    // sharedBuffer = Buffer.allocUnsafeSlow(32); // 8KB

    filteredOperations: FilteredOperation[];

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for each new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        console.log("has filters?", this.context.hasFilters);

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
        view?: StateView<T>,
        it: Iterator = { offset: 0 },
        bytes = this.sharedBuffer,
    ) {
        const encodeAll = (view === undefined);
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

            const ctor = ref['constructor'];
            const encoder = ctor[$encoder];
            const filter = ctor[$filter];

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

                if (filter !== undefined && filter(ref, fieldIndex, view)) {
                    const metadata = ctor[Symbol.metadata];
                    const fieldName = metadata[fieldIndex];
                    const field = metadata[fieldName];
                    console.log("skip...", fieldName, field);
                    continue;
                }

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

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            //
            this.sharedBuffer = Buffer.allocUnsafeSlow(newSize);
            return this.encode(view, it, bytes);

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
            return bytes;
        }
    }

    encodeAll(it: Iterator = { offset: 0 }) {
        return this.encode(undefined, it);
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