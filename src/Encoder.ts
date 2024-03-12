import type { Schema } from "./Schema";
import { TypeContext } from "./annotations";
import { $changes, $encoder, $filter, $isOwned } from "./changes/consts";

import * as encode from "./encoding/encode";
import type { Iterator } from "./encoding/decode";

import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTree, Root } from "./changes/ChangeTree";
import { getNextPowerOf2 } from "./utils";
import { StateView } from "./filters/StateView";

export class Encoder<T extends Schema = any> {
    static BUFFER_SIZE = 8 * 1024;// 8KB

    context: TypeContext;

    root: T;
    $root: Root;

    sharedBuffer = Buffer.allocUnsafeSlow(Encoder.BUFFER_SIZE);

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
        it: Iterator = { offset: 0 },
        view?: StateView<T>,
        bytes = this.sharedBuffer,
        changeTrees = this.$root.changes
    ): Buffer {
        const offset = it.offset; // cache current offset in case we need to resize the buffer

        const hasView = (view !== undefined);
        const rootChangeTree = this.root[$changes];

        const changeTreesIterator = changeTrees.entries();

        for (const [changeTree, changes] of changeTreesIterator) {
            const ref = changeTree.ref;

            const ctor = ref['constructor'];
            const encoder = ctor[$encoder];
            const isOwned = ctor[$isOwned];

            if (hasView && !view['owned'].has(changeTree)) {
                // console.log("NOT OWNED structure, skip", ref.constructor.name, `(refId: ${changeTree.refId})`)
                continue;
            }

            if (changeTree !== rootChangeTree) { // root `refId` is skipped.
                bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(bytes, changeTree.refId, it);
            }

            const changesIterator = changes.entries();

            for (const [fieldIndex, operation] of changesIterator) {

                //
                // first pass (encodeAll), identify "filtered" operations without encoding them
                // they will be encoded per client, based on their view.
                //
                // TODO: how can we optimize filtering out "encode all" operations?
                //
                if (!hasView && isOwned && isOwned(ref, fieldIndex)) {
                    continue;
                }

                // console.log("ENCODE", ref.constructor.name, `(refId: ${changeTree.refId})`, "fieldIndex =>", fieldIndex, "operation =>", operation);

                encoder(this, bytes, changeTree, fieldIndex, operation, it);
            }

        }

        if (it.offset > bytes.byteLength) {
            const newSize = getNextPowerOf2(this.sharedBuffer.byteLength * 2);
            console.warn("@colyseus/schema encode buffer overflow. Current buffer size: " + bytes.byteLength + ", encoding offset: " + it.offset + ", new size: " + newSize);

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            //
            this.sharedBuffer = Buffer.allocUnsafeSlow(newSize);
            return this.encode({ offset }, view);

        } else {
            //
            // only clear changes after making sure buffer resize is not required.
            //

            // return bytes;
            return bytes.slice(0, it.offset);
        }
    }

    encodeAll(it: Iterator = { offset: 0 }) {
        return this.encode(it, undefined, this.sharedBuffer, this.$root.allChanges);
    }

    encodeView(view: StateView<T>, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // try to encode "filtered" changes
        this.encode(it, view, bytes, this.$root.filteredChanges);

        return Buffer.concat([
            bytes.slice(0, sharedOffset),
            bytes.slice(viewOffset, it.offset)
        ]);
    }

    discardChanges() {
        this.$root.changes.clear();
        this.$root.filteredChanges.clear();
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