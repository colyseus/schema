import type { Schema } from "../Schema";
import { TypeContext } from "../types/TypeContext";
import { $changes, $encoder, $filter, $onEncodeEnd } from "../types/symbols";

import * as encode from "../encoding/encode";
import type { Iterator } from "../encoding/decode";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec';
import { Root } from "./Root";
import { getNextPowerOf2 } from "../utils";

import type { StateView } from "./StateView";
import type { Metadata } from "../Metadata";
import type { ChangeSet } from "./ChangeTree";

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
        changeSetName: "changes" | "allChanges" | "filteredChanges" | "allFilteredChanges" = "changes",
        isEncodeAll = changeSetName === "allChanges",
        initialOffset = it.offset // cache current offset in case we need to resize the buffer
    ): Buffer {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        const shouldClearChanges = !isEncodeAll && !hasView;
        const changeTrees = this.root[changeSetName];

        for (let i = 0, numChangeTrees = changeTrees.length; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            if (changeTree === undefined) {
                continue;
            }

            const changeSet = changeTree[changeSetName];
            const ref = changeTree.ref;

            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const filter = ctor[$filter];
            const metadata = ctor[Symbol.metadata];

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

            const changeSetKeys = Object.keys(changeSet);
            for (let j = 0, numChanges = changeSetKeys.length; j < numChanges; j++) {
                const fieldIndex = Number(changeSetKeys[j]);
                const operation = changeSet[fieldIndex];

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

                encoder(this, buffer, changeTree, fieldIndex, operation, it, isEncodeAll, hasView, metadata);
            }

            if (shouldClearChanges) {
                // changeTree.endEncode();
                changeTree.changes = {};

                // ArraySchema and MapSchema have a custom "encode end" method
                changeTree.ref[$onEncodeEnd]?.();

                // Not a new instance anymore
                changeTree.isNew = false;
            }
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

            return this.encode({ offset: initialOffset }, view, buffer, changeSetName, isEncodeAll);

        } else {
            // //
            // // only clear changes after making sure buffer resize is not required.
            // //
            // if (shouldClearChanges) {
            //     //
            //     // FIXME: avoid iterating over change trees twice.
            //     //
            //     this.onEndEncode(changeTrees);
            // }

            return buffer.subarray(0, it.offset);
        }
    }

    encodeAll(it: Iterator = { offset: 0 }, buffer: Buffer = this.sharedBuffer) {
        // console.log(`\nencodeAll(), this.root.allChanges (${this.root.allChanges.size})`);
        // this.debugChanges("allChanges");

        return this.encode(it, undefined, buffer, "allChanges", true);
    }

    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // console.log(`\nencodeAllView(), this.root.allFilteredChanges (${this.root.allFilteredChanges.size})`);
        // this.debugChanges("allFilteredChanges");

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "allFilteredChanges", true, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    debugChanges(
        field: "changes" | "allFilteredChanges" | "allChanges" | "filteredChanges" | { [refId: number]: ChangeSet }
    ) {
        const rootChangeSet = (typeof (field) === "string")
            ? this.root[field]
            : field;

        for (const refId in rootChangeSet) {
            const changeTree = this.root.changeTrees[refId];
            const changeSet = rootChangeSet[refId];

            const metadata: Metadata = changeTree.ref.constructor[Symbol.metadata];
            console.log("->", { ref: changeTree.ref.constructor.name, refId: changeTree.refId, changes: Object.keys(changeSet).length });
            for (const index in changeSet) {
                const op = changeSet[index];
                console.log("  ->", {
                    index,
                    field: metadata?.[index],
                    op: OPERATION[op],
                });
            }
        }
    }

    encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // console.log(`\nencodeView(), view.changes (${view.changes.size})`);
        // this.debugChanges(view.changes);

        // console.log(`\nencodeView(), this.root.filteredChanges (${this.root.filteredChanges.size})`);
        // this.debugChanges("filteredChanges");

        // encode visibility changes (add/remove for this view)
        const refIds = Object.keys(view.changes);
        for (let i = 0, numRefIds = refIds.length; i < numRefIds; i++) {
            const refId = refIds[i];
            const changes = view.changes[refIds[i]];
            const changeTree = this.root.changeTrees[refId];

            if (
                changeTree === undefined ||
                Object.keys(changes).length === 0 // FIXME: avoid having empty changes if no changes were made
            ) {
                // console.log("changes.size === 0", changeTree.ref.constructor.name);
                continue;
            }

            const ref = changeTree.ref;

            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const metadata = ctor[Symbol.metadata];

            bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
            encode.number(bytes, changeTree.refId, it);

            const keys = Object.keys(changes);
            for (let i = 0, numChanges = keys.length; i < numChanges; i++) {
                const key = keys[i];
                const operation = changes[key];

                // isEncodeAll = false
                // hasView = true
                encoder(this, bytes, changeTree, Number(key), operation, it, false, true, metadata);
            }
        }

        //
        // TODO: only clear view changes after all views are encoded
        // (to allow re-using StateView's for multiple clients)
        //
        // clear "view" changes after encoding
        view.changes = {};

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "filteredChanges", false, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    onEndEncode(changeTrees = this.root.changes) {
        // changeTrees.forEach(function(changeTree) {
        //     changeTree.endEncode();
        // });


        // for (const refId in changeTrees) {
        //     const changeTree = this.root.changeTrees[refId];
        //     changeTree.endEncode();

        //     // changeTree.changes.clear();

        //     // // ArraySchema and MapSchema have a custom "encode end" method
        //     // changeTree.ref[$onEncodeEnd]?.();

        //     // // Not a new instance anymore
        //     // delete changeTree[$isNew];
        // }
    }

    discardChanges() {
        // discard shared changes
        let length = this.root.changes.length;
        if (length > 0) {
            while (length--) {
                this.root.changes[length]?.endEncode();
            }
            this.root.changes.length = 0;
        }

        // discard filtered changes
        length = this.root.filteredChanges.length;
        if (length > 0) {
            while (length--) {
                this.root.filteredChanges[length]?.endEncode();
            }
            this.root.filteredChanges.length = 0;
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
