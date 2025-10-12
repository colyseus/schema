import type { Schema } from "../Schema";
import { TypeContext } from "../types/TypeContext";
import { $changes, $encoder, $filter, $getByIndex } from "../types/symbols";

import { encode } from "../encoding/encode";
import type { Iterator } from "../encoding/decode";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec';
import { Root } from "./Root";

import type { StateView } from "./StateView";
import type { Metadata } from "../Metadata";
import type { ChangeSetName, ChangeTree, ChangeTreeList, ChangeTreeNode } from "./ChangeTree";
import { createChangeTreeList } from "./ChangeTree";

export class Encoder<T extends Schema = any> {
    static BUFFER_SIZE = (typeof(Buffer) !== "undefined") && Buffer.poolSize || 8 * 1024; // 8KB
    sharedBuffer = Buffer.allocUnsafe(Encoder.BUFFER_SIZE);

    context: TypeContext;
    state: T;

    root: Root;

    constructor(state: T) {
        //
        // Use .cache() here to avoid re-creating a new context for every new room instance.
        //
        // We may need to make this optional in case of dynamically created
        // schemas - which would lead to memory leaks
        //
        this.context = TypeContext.cache(state.constructor as typeof Schema);
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
        changeSetName: ChangeSetName = "changes",
        isEncodeAll = changeSetName === "allChanges",
        initialOffset = it.offset // cache current offset in case we need to resize the buffer
    ): Buffer {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        let current: ChangeTreeList | ChangeTreeNode = this.root[changeSetName];

        while (current = current.next) {
            const changeTree = (current as ChangeTreeNode).changeTree;

            if (hasView) {
                if (!view.isChangeTreeVisible(changeTree)) {
                    // console.log("MARK AS INVISIBLE:", { ref: changeTree.ref.constructor.name, refId: changeTree.refId, raw: changeTree.ref.toJSON() });
                    view.invisible.add(changeTree);
                    continue; // skip this change tree
                }
                view.invisible.delete(changeTree); // remove from invisible list
            }

            const changeSet = changeTree[changeSetName];
            const ref = changeTree.ref;

            // TODO: avoid iterating over change tree if no changes were made
            const numChanges = changeSet.operations.length;
            if (numChanges === 0) { continue; }

            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const filter = ctor[$filter];
            const metadata = ctor[Symbol.metadata];

            // skip root `refId` if it's the first change tree
            // (unless it "hasView", which will need to revisit the root)
            if (hasView || it.offset > initialOffset || changeTree !== rootChangeTree) {
                buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(buffer, changeTree.refId, it);
            }

            for (let j = 0; j < numChanges; j++) {
                const fieldIndex = changeSet.operations[j];

                if (fieldIndex < 0) {
                    // "pure" operation without fieldIndex (e.g. CLEAR, REVERSE, etc.)
                    // encode and continue early - no need to reach $filter check
                    buffer[it.offset++] = Math.abs(fieldIndex) & 255;
                    continue;
                }

                const operation = (isEncodeAll)
                    ? OPERATION.ADD
                    : changeTree.indexedOperations[fieldIndex];

                //
                // first pass (encodeAll), identify "filtered" operations without encoding them
                // they will be encoded per client, based on their view.
                //
                // TODO: how can we optimize filtering out "encode all" operations?
                // TODO: avoid checking if no view tags were defined
                //
                if (fieldIndex === undefined || operation === undefined || (filter && !filter(ref, fieldIndex, view))) {
                    // console.log("ADD AS INVISIBLE:", fieldIndex, changeTree.ref.constructor.name)
                    // view?.invisible.add(changeTree);
                    continue;
                }

                encoder(this, buffer, changeTree, fieldIndex, operation, it, isEncodeAll, hasView, metadata);
            }
        }

        if (it.offset > buffer.byteLength) {
            // we can assume that n + 1 poolSize will suffice given that we are likely done with encoding at this point
            // multiples of poolSize are faster to allocate than arbitrary sizes
            // if we are on an older platform that doesn't implement pooling use 8kb as poolSize (that's the default for node)
            const newSize = Math.ceil(it.offset / (Buffer.poolSize ?? 8 * 1024)) * (Buffer.poolSize ?? 8 * 1024);

            console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            // -> No we probably can't unless we catch the need for resize before encoding which is likely more computationally expensive than resizing on demand
            //
            buffer = Buffer.alloc(newSize, buffer); // fill with buffer here to memcpy previous encoding steps beyond the initialOffset

            // assign resized buffer to local sharedBuffer
            if (buffer === this.sharedBuffer) {
                this.sharedBuffer = buffer;
            }

            return this.encode({ offset: initialOffset }, view, buffer, changeSetName, isEncodeAll);

        } else {

            return buffer.subarray(0, it.offset);
        }
    }

    encodeAll(it: Iterator = { offset: 0 }, buffer: Buffer = this.sharedBuffer) {
        return this.encode(it, undefined, buffer, "allChanges", true);
    }

    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "allFilteredChanges", true, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes = this.sharedBuffer) {
        const viewOffset = it.offset;

        // encode visibility changes (add/remove for this view)
        for (const [refId, changes] of view.changes) {
            const changeTree: ChangeTree = this.root.changeTrees[refId];

            if (changeTree === undefined) {
                // detached instance, remove from view and skip.
                // console.log("detached instance, remove from view and skip.", refId);
                view.changes.delete(refId);
                continue;
            }

            const keys = Object.keys(changes);
            if (keys.length === 0) {
                // FIXME: avoid having empty changes if no changes were made
                // console.log("changes.size === 0, skip", refId, changeTree.ref.constructor.name);
                continue;
            }

            const ref = changeTree.ref;

            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const metadata = ctor[Symbol.metadata];

            bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
            encode.number(bytes, changeTree.refId, it);

            for (let i = 0, numChanges = keys.length; i < numChanges; i++) {
                const index = Number(keys[i]);
                // workaround when using view.add() on item that has been deleted from state (see test "adding to view item that has been removed from state")
                const value = changeTree.ref[$getByIndex](index);
                const operation = (value !== undefined && changes[index]) || OPERATION.DELETE;

                // isEncodeAll = false
                // hasView = true
                encoder(this, bytes, changeTree, index, operation, it, false, true, metadata);
            }
        }

        //
        // TODO: only clear view changes after all views are encoded
        // (to allow re-using StateView's for multiple clients)
        //
        // clear "view" changes after encoding
        view.changes.clear();

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "filteredChanges", false, viewOffset);

        return Buffer.concat([
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        ]);
    }

    discardChanges() {
        // discard shared changes
        let current = this.root.changes.next;
        while (current) {
            current.changeTree.endEncode('changes');
            current = current.next;
        }
        this.root.changes = createChangeTreeList();

        // discard filtered changes
        current = this.root.filteredChanges.next;
        while (current) {
            current.changeTree.endEncode('filteredChanges');
            current = current.next;
        }
        this.root.filteredChanges = createChangeTreeList();
    }

    tryEncodeTypeId (bytes: Buffer, baseType: typeof Schema, targetType: typeof Schema, it: Iterator) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        if (targetTypeId === undefined) {
            console.warn(`@colyseus/schema WARNING: Class "${targetType.name}" is not registered on TypeRegistry - Please either tag the class with @entity or define a @type() field.`);
            return;
        }

        if (baseTypeId !== targetTypeId) {
            bytes[it.offset++] = TYPE_ID & 255;
            encode.number(bytes, targetTypeId, it);
        }
    }

    get hasChanges() {
        return (
            this.root.changes.next !== undefined ||
            this.root.filteredChanges.next !== undefined
        );
    }
}
