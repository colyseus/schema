import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $changes, $encoder, $filter, $getByIndex, $refId } from "../types/symbols.js";

import { encode } from "../encoding/encode.js";
import type { Iterator } from "../encoding/decode.js";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec.js';
import { Root } from "./Root.js";

import type { StateView } from "./StateView.js";
import type { ChangeSetName, ChangeTree, ChangeTreeList, ChangeTreeNode } from "./ChangeTree.js";
import { createChangeTreeList } from "./ChangeTree.js";

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
}

export class Encoder<T extends Schema = any> {
    static BUFFER_SIZE = 8 * 1024; // 8KB
    sharedBuffer: Uint8Array = new Uint8Array(Encoder.BUFFER_SIZE);

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
        buffer: Uint8Array = this.sharedBuffer,
        changeSetName: ChangeSetName = "changes",
        isEncodeAll = changeSetName === "allChanges",
        initialOffset = it.offset // cache current offset in case we need to resize the buffer
    ): Uint8Array {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        let current: ChangeTreeList | ChangeTreeNode = this.root[changeSetName];

        while (current = current.next) {
            const changeTree = (current as ChangeTreeNode).changeTree;

            if (hasView) {
                if (!view.isChangeTreeVisible(changeTree)) {
                    // console.log("MARK AS INVISIBLE:", { ref: changeTree.ref.constructor.name, refId: changeTree.ref[$refId], raw: changeTree.ref.toJSON() });
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
                encode.number(buffer, ref[$refId], it);
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
            // we can assume that n + 1 BUFFER_SIZE will suffice given that we are likely done with encoding at this point
            // multiples of BUFFER_SIZE are faster to allocate than arbitrary sizes
            const newSize = Math.ceil(it.offset / Encoder.BUFFER_SIZE) * Encoder.BUFFER_SIZE;

            console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

            //
            // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
            // -> No we probably can't unless we catch the need for resize before encoding which is likely more computationally expensive than resizing on demand
            //
            const newBuffer = new Uint8Array(newSize);
            newBuffer.set(buffer); // copy previous encoding steps beyond the initialOffset
            buffer = newBuffer;

            // assign resized buffer to local sharedBuffer
            if (buffer === this.sharedBuffer) {
                this.sharedBuffer = buffer;
            }

            return this.encode({ offset: initialOffset }, view, buffer, changeSetName, isEncodeAll);

        } else {

            return buffer.subarray(0, it.offset);
        }
    }

    encodeAll(
        it: Iterator = { offset: 0 },
        buffer: Uint8Array = this.sharedBuffer
    ) {
        return this.encode(it, undefined, buffer, "allChanges", true);
    }

    encodeAllView(
        view: StateView,
        sharedOffset: number,
        it: Iterator,
        bytes: Uint8Array = this.sharedBuffer
    ) {
        const viewOffset = it.offset;

        this.encodeViewChanges(view, it, bytes);

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "allFilteredChanges", true, viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
    }

    encodeView(
        view: StateView,
        sharedOffset: number,
        it: Iterator,
        bytes: Uint8Array = this.sharedBuffer
    ) {
        const viewOffset = it.offset;

        this.encodeViewChanges(view, it, bytes);

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "filteredChanges", false, viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
    }

    protected encodeViewChanges(
        view: StateView,
        it: Iterator,
        bytes: Uint8Array = this.sharedBuffer
    ) {
        //
        // Iterate `view.changes` in topological order so a refId is never
        // SWITCH_TO_STRUCTURE'd before an earlier op has introduced it on
        // the decoder. Map insertion order alone isn't sufficient: a
        // sequence like view.remove(child) → view.add(child) on a child
        // whose ancestor wasn't yet visible can put the child entry into
        // the Map before its newly-visible ancestor.
        //
        // Hot-path optimization: `view.add` preserves topo order by
        // construction (addParentOf walks deepest-ancestor-first before
        // touching the obj's own entry). Only `view.remove` can leave the
        // Map dirty. `StateView.changesOutOfOrder` tracks this so most
        // encodes can iterate `view.changes` directly, paying nothing.
        //
        const orderedRefIds: Iterable<number> = view.changesOutOfOrder
            ? this.topoOrderViewChanges(view)
            : view.changes.keys();

        for (const refId of orderedRefIds) {
            const changes = view.changes.get(refId);
            const changeTree: ChangeTree = this.root.changeTrees[refId];

            if (changeTree === undefined) {
                // detached instance, remove from view and skip.
                // console.log("detached instance, remove from view and skip.", refId);
                view.changes.delete(refId);
                continue;
            }

            const ref = changeTree.ref;
            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const metadata = ctor[Symbol.metadata];
            const keys = Object.keys(changes).filter((index) => {
                if (metadata && metadata[Number(index)] === undefined) {
                    delete changes[Number(index)];
                    return false;
                }

                return true;
            });

            if (keys.length === 0) {
                // FIXME: avoid having empty changes if no changes were made
                // console.log("changes.size === 0, skip", refId, changeTree.ref.constructor.name);
                view.changes.delete(refId);
                continue;
            }

            bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
            encode.number(bytes, ref[$refId], it);

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
        view.changesOutOfOrder = false;
    }

    /**
     * Produce a topological ordering of `view.changes` keys so each refId
     * is preceded by any ancestor that's also in the same view's changeset.
     *
     * The wire stream uses SWITCH_TO_STRUCTURE pointers; if a child is
     * encoded before any earlier op has introduced its refId on the
     * decoder, decode fails with "refId not found". An entry's refId can
     * only be introduced by an ADD on one of its ancestors — so any
     * ancestor that itself appears in this view's pending changes must
     * be encoded first.
     *
     * Implementation: DFS post-order over the parent chain. The `visited`
     * Set guards against duplicates; cycles are not expected in a
     * well-formed parent chain but the visited check is a cheap safety
     * net. Cost is O(n × d) for n entries with parent-chain depth d.
     */
    protected topoOrderViewChanges(view: StateView): number[] {
        const result: number[] = [];
        const visited = new Set<number>();

        const visit = (refId: number) => {
            if (visited.has(refId)) { return; }
            visited.add(refId);

            const changeTree = this.root.changeTrees[refId];
            if (changeTree !== undefined) {
                let chain = changeTree.parentChain;
                while (chain) {
                    const parentRefId = chain.ref[$refId];
                    if (parentRefId !== undefined && view.changes.has(parentRefId)) {
                        visit(parentRefId);
                    }
                    chain = chain.next;
                }
            }

            result.push(refId);
        };

        for (const refId of view.changes.keys()) {
            visit(refId);
        }

        return result;
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

    tryEncodeTypeId(
        bytes: Uint8Array,
        baseType: typeof Schema,
        targetType: typeof Schema,
        it: Iterator
    ) {
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
