import type { Schema } from "../Schema";
import { TypeContext } from "../annotations";
import { $changes, $encoder, $filter } from "../types/symbols";

import * as encode from "../encoding/encode";
import type { Iterator } from "../encoding/decode";

import { SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec';
import { Root } from "./ChangeTree";
import { getNextPowerOf2 } from "../utils";
import type { StateView } from "./StateView";

export class Encoder<T extends Schema = any> {
    static BUFFER_SIZE = 8 * 1024;// 8KB
    sharedBuffer = Buffer.allocUnsafeSlow(Encoder.BUFFER_SIZE);

    context: TypeContext;
    state: T;

    root: Root;

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for every new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Encoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(state: T) {
        this.root = new Root();
        this.state = state;
        state[$changes].setRoot(this.root);
    }

    encode(
        it: Iterator = { offset: 0 },
        view?: StateView,
        buffer = this.sharedBuffer,
        changeTrees = this.root.changes
    ): Buffer {
        const initialOffset = it.offset; // cache current offset in case we need to resize the buffer

        const isEncodeAll = this.root.allChanges === changeTrees;
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        const changeTreesIterator = changeTrees.entries();

        for (const [changeTree, changes] of changeTreesIterator) {
            const ref = changeTree.ref;

            const ctor = ref['constructor'];
            const encoder = ctor[$encoder];
            const filter = ctor[$filter];

            if (hasView) {
                if (!view.items.has(changeTree)) {
                    view.invisible.add(changeTree);
                    continue; // skip this change tree

                } else if (view.invisible.has(changeTree)) {
                    view.invisible.delete(changeTree); // remove from invisible list
                }
            }

            // skip root `refId` if it's the first change tree
            if (it.offset !== initialOffset || changeTree !== rootChangeTree) {
                buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(buffer, changeTree.refId, it);
            }

            const changesIterator = changes.entries();

            for (const [fieldIndex, operation] of changesIterator) {
                //
                // first pass (encodeAll), identify "filtered" operations without encoding them
                // they will be encoded per client, based on their view.
                //
                // TODO: how can we optimize filtering out "encode all" operations?
                // TODO: avoid checking if no view tags were defined
                //
                if (filter && !filter(ref, fieldIndex, view)) {
                    // console.log("SKIP FIELD:", { ref: changeTree.ref.constructor.name, fieldIndex, })

                    // console.log("ADD AS INVISIBLE:", fieldIndex, changeTree.ref.constructor.name)
                    // view?.invisible.add(changeTree);
                    continue;
                }

                // console.log("WILL ENCODE", {
                //     ref: changeTree.ref.constructor.name,
                //     fieldIndex,
                //     operation: OPERATION[operation],
                // });

                encoder(this, buffer, changeTree, fieldIndex, operation, it, isEncodeAll, hasView);
            }
        }

        if (it.offset > buffer.byteLength) {
            const newSize = getNextPowerOf2(buffer.byteLength * 2);
            console.warn("@colyseus/schema encode buffer overflow. Current buffer size: " + buffer.byteLength + ", encoding offset: " + it.offset + ", new size: " + newSize);

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            //
            buffer = Buffer.allocUnsafeSlow(newSize);

            // assign resized buffer to local sharedBuffer
            if (buffer === this.sharedBuffer) {
                this.sharedBuffer = buffer;
            }

            return this.encode({ offset: initialOffset }, view, buffer);

        } else {
            //
            // only clear changes after making sure buffer resize is not required.
            //
            if (!isEncodeAll && !hasView) {
                //
                // FIXME: avoid iterating over change trees twice.
                //
                this.onEndEncode(changeTrees);
            }

            // return bytes;
            return buffer.slice(0, it.offset);
        }
    }

    encodeAll(it: Iterator = { offset: 0 }, buffer: Buffer = this.sharedBuffer) {
        // console.log(`encodeAll(), this.$root.allChanges (${this.$root.allChanges.size})`);

        // Array.from(this.$root.allChanges.entries()).map((item) => {
        //     console.log("->", item[0].refId, item[0].ref.toJSON());
        // });

        return this.encode(it, undefined, buffer, this.root.allChanges);
    }

    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // console.log(`encodeAllView(), this.$root.allFilteredChanges (${this.$root.allFilteredChanges.size})`);
        // this.debugAllFilteredChanges();

        // try to encode "filtered" changes
        this.encode(it, view, bytes, this.root.allFilteredChanges);

        return Buffer.concat([
            bytes.slice(0, sharedOffset),
            bytes.slice(viewOffset, it.offset)
        ]);
    }


    // debugAllFilteredChanges() {
    //     Array.from(this.$root.allFilteredChanges.entries()).map((item) => {
    //         console.log("->", { refId: item[0].refId }, item[0].ref.toJSON());
    //         if (Array.isArray(item[0].ref.toJSON())) {
    //             item[1].forEach((op, key) => {
    //                 console.log("  ->", { key, op: OPERATION[op] });
    //             })
    //         }
    //     });
    // }

    encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // try to encode "filtered" changes
        this.encode(it, view, bytes, this.root.filteredChanges);

        // encode visibility changes (add/remove for this view)
        const viewChangesIterator = view.changes.entries();
        for (const [changeTree, changes] of viewChangesIterator) {
            if (changes.size === 0) {
                // FIXME: avoid having empty changes if no changes were made
                // console.log("changes.size === 0", changeTree.ref.constructor.name);
                continue;
            }

            const ref = changeTree.ref;

            const ctor = ref['constructor'];
            const encoder = ctor[$encoder];

            bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
            encode.number(bytes, changeTree.refId, it);

            const changesIterator = changes.entries();

            for (const [fieldIndex, operation] of changesIterator) {
                // isEncodeAll = false
                // hasView = true
                encoder(this, bytes, changeTree, fieldIndex, operation, it, false, true);
            }
        }

        //
        // TODO: only clear view changes after all views are encoded
        // (to allow re-using StateView's for multiple clients)
        //
        // clear "view" changes after encoding
        view.changes.clear();

        return Buffer.concat([
            bytes.slice(0, sharedOffset),
            bytes.slice(viewOffset, it.offset)
        ]);
    }

    onEndEncode(changeTrees = this.root.changes) {
        const changeTreesIterator = changeTrees.entries();
        for (const [changeTree, _] of changeTreesIterator) {
            changeTree.endEncode();
        }
    }

    discardChanges() {
        // discard shared changes
        if (this.root.changes.size > 0) {
            this.onEndEncode(this.root.changes);
            this.root.changes.clear();
        }
        // discard filtered changes
        if (this.root.filteredChanges.size > 0) {
            this.onEndEncode(this.root.filteredChanges);
            this.root.filteredChanges.clear();
        }
    }

    tryEncodeTypeId (bytes: Buffer, baseType: typeof Schema, targetType: typeof Schema, it: Iterator) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        if (baseTypeId !== targetTypeId) {
            bytes[it.offset++] = TYPE_ID & 255;
            encode.number(bytes, targetTypeId, it);
        }
    }
}