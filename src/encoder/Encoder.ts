import type { Schema } from "../Schema";
import { TypeContext } from "../types/TypeContext";
import { $changes, $encoder, $filter, $isNew, $onEncodeEnd } from "../types/symbols";

import * as encode from "../encoding/encode";
import type { Iterator } from "../encoding/decode";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec';
import { Root } from "./Root";
import { getNextPowerOf2 } from "../utils";

import type { StateView } from "./StateView";
import type { Metadata } from "../Metadata";
import type { ChangeTree } from "./ChangeTree";

export class Encoder<T extends Schema = any> {
    static BUFFER_SIZE = 8 * 1024;// 8KB
    sharedBuffer = Buffer.allocUnsafeSlow(Encoder.BUFFER_SIZE);

    context: TypeContext;
    state: T;

    root: Root;

    constructor(state: T) {

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for every new room)
        //
        this.context = new TypeContext(state.constructor as typeof Schema);
        this.root = new Root(this.context);

        this.setState(state);

        // console.log(">>>>>>>>>>>>>>>> Encoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setState(state: T) {
        this.state = state;
        this.state[$changes].setRoot(this.root);
    }

    encode(
        it: Iterator = { offset: 0 },
        view?: StateView,
        buffer = this.sharedBuffer,
        changeTrees = this.root.changes,
        isEncodeAll = this.root.allChanges === changeTrees,
        initialOffset = it.offset // cache current offset in case we need to resize the buffer
    ): Buffer {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        const shouldClearChanges = !isEncodeAll && !hasView;

        for (const [changeTree, changes] of changeTrees.entries()) {
            const ref = changeTree.ref;

            const ctor = ref['constructor'];
            const encoder = ctor[$encoder];
            const filter = ctor[$filter];

            // try { throw new Error(); } catch (e) {
            //     // only print if not coming from Reflection.ts
            //     if (!e.stack.includes("src/Reflection.ts")) {
            //         console.log("ChangeTree:", { ref: ref.constructor.name, });
            //     }
            // }

            if (hasView) {
                if (!view.items.has(changeTree)) {
                    view.invisible.add(changeTree);
                    continue; // skip this change tree

                } else if (view.invisible.has(changeTree)) {
                    view.invisible.delete(changeTree); // remove from invisible list
                }
            }

            // skip root `refId` if it's the first change tree
            // (unless it "hasView", which will need to revisit the root)
            if (hasView || it.offset > initialOffset || changeTree !== rootChangeTree) {
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
                    // console.log("ADD AS INVISIBLE:", fieldIndex, changeTree.ref.constructor.name)
                    // view?.invisible.add(changeTree);
                    continue;
                }

                // try { throw new Error(); } catch (e) {
                //     // only print if not coming from Reflection.ts
                //     if (!e.stack.includes("src/Reflection.ts")) {
                //         console.log("WILL ENCODE", {
                //             ref: changeTree.ref.constructor.name,
                //             fieldIndex,
                //             operation: OPERATION[operation],
                //         });
                //     }
                // }

                encoder(this, buffer, changeTree, fieldIndex, operation, it, isEncodeAll, hasView);
            }

            // if (shouldClearChanges) {
            //     changeTree.endEncode();
            // }
        }

        if (it.offset > buffer.byteLength) {
            const newSize = getNextPowerOf2(buffer.byteLength * 2);
            console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            //
            buffer = Buffer.allocUnsafeSlow(newSize);

            // assign resized buffer to local sharedBuffer
            if (buffer === this.sharedBuffer) {
                this.sharedBuffer = buffer;
            }

            return this.encode({ offset: initialOffset }, view, buffer, changeTrees, isEncodeAll);

        } else {
            //
            // only clear changes after making sure buffer resize is not required.
            //
            if (shouldClearChanges) {
                //
                // FIXME: avoid iterating over change trees twice.
                //
                this.onEndEncode(changeTrees);
            }

            return buffer.subarray(0, it.offset);
        }
    }

    encodeAll(it: Iterator = { offset: 0 }, buffer: Buffer = this.sharedBuffer) {
        // console.log(`\nencodeAll(), this.root.allChanges (${this.root.allChanges.size})`);
        // this.debugChanges("allChanges");

        return this.encode(it, undefined, buffer, this.root.allChanges, true);
    }

    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // console.log(`\nencodeAllView(), this.root.allFilteredChanges (${this.root.allFilteredChanges.size})`);
        // this.debugChanges("allFilteredChanges");

        // try to encode "filtered" changes
        this.encode(it, view, bytes, this.root.allFilteredChanges, true, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    debugChanges(
        field:  "changes" | "allFilteredChanges" | "allChanges" | "filteredChanges" | Map<ChangeTree, Map<number, OPERATION>>
    ) {
        const changeSet = (typeof (field) === "string")
            ? this.root[field]
            : field;

        Array.from(changeSet.entries()).map((item) => {
            const metadata: Metadata = item[0].ref.constructor[Symbol.metadata];
            console.log("->", { ref: item[0].ref.constructor.name, refId: item[0].refId, changes: item[1].size });
            item[1].forEach((op, index) => {
                console.log("  ->", {
                    index,
                    field: metadata?.[index],
                    op: OPERATION[op],
                });
            });
        });
    }

    encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // console.log(`\nencodeView(), view.changes (${view.changes.size})`);
        // this.debugChanges(view.changes);

        // console.log(`\nencodeView(), this.root.filteredChanges (${this.root.filteredChanges.size})`);
        // this.debugChanges("filteredChanges");

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

        // try to encode "filtered" changes
        this.encode(it, view, bytes, this.root.filteredChanges, false, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    onEndEncode(changeTrees = this.root.changes) {
        const changeTreesIterator = changeTrees.entries();
        for (const [changeTree, _] of changeTreesIterator) {
            changeTree.endEncode();
            // changeTree.changes.clear();

            // // ArraySchema and MapSchema have a custom "encode end" method
            // changeTree.ref[$onEncodeEnd]?.();

            // // Not a new instance anymore
            // delete changeTree[$isNew];

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
