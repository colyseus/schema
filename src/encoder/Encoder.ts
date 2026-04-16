import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { Metadata } from "../Metadata.js";
import { $changes, $encoder, $filter, $getByIndex, $refId } from "../types/symbols.js";

import { encode } from "../encoding/encode.js";
import type { Iterator } from "../encoding/decode.js";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec.js';
import { Root } from "./Root.js";

import type { StateView } from "./StateView.js";
import type { ChangeSetName, ChangeTree, ChangeTreeList, ChangeTreeNode } from "./ChangeTree.js";
import { createChangeTreeList } from "./ChangeTree.js";
import type { EncodeOperation } from "./EncodeOperation.js";

/**
 * Reusable context passed to the recorder's forEachWithCtx to iterate changes
 * without allocating a closure per ChangeTree. All fields are (re)assigned
 * inside the main encode loop before each `forEachWithCtx` call.
 */
interface EncodeCtx {
    self: Encoder;
    buffer: Uint8Array;
    it: Iterator;
    changeTree: ChangeTree;
    ref: any;
    encoder: EncodeOperation;
    filter: ((ref: any, index: number, view?: StateView) => boolean) | undefined;
    metadata: any;
    view: StateView | undefined;
    isEncodeAll: boolean;
    hasView: boolean;
}

// Pure (non-capturing) callback for the recorder's forEachWithCtx. Module-
// level so V8 never needs to allocate a fresh function per tree.
function encodeChangeCb(ctx: EncodeCtx, fieldIndex: number, op: OPERATION): void {
    if (fieldIndex < 0) {
        // Pure op (CLEAR/REVERSE): encoded as a single byte.
        ctx.buffer[ctx.it.offset++] = Math.abs(fieldIndex) & 255;
        return;
    }
    const operation = ctx.isEncodeAll ? OPERATION.ADD : op;
    if (operation === undefined) return;
    if (ctx.filter !== undefined && !ctx.filter(ctx.ref, fieldIndex, ctx.view)) return;
    ctx.encoder(ctx.self, ctx.buffer, ctx.changeTree, fieldIndex, operation, ctx.it, ctx.isEncodeAll, ctx.hasView, ctx.metadata);
}

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

    constructor(state: T, root?: Root) {
        //
        // Use .cache() here to avoid re-creating a new context for every new room instance.
        //
        // We may need to make this optional in case of dynamically created
        // schemas - which would lead to memory leaks
        //
        this.context = TypeContext.cache(state.constructor as typeof Schema);
        this.root = root ?? new Root(this.context);

        this.setState(state);
    }

    protected setState(state: T) {
        this.state = state;
        this.state[$changes].setRoot(this.root);
    }

    // Reused context for encode iteration — avoids allocating a closure per
    // ChangeTree in the hot encode path.
    private _encodeCtx: EncodeCtx = {
        self: undefined!, buffer: undefined!, it: undefined!, changeTree: undefined!,
        ref: undefined, encoder: undefined!, filter: undefined, metadata: undefined,
        view: undefined, isEncodeAll: false, hasView: false,
    };

    /**
     * Dedupe set used by the structural full-sync walker. Reused across calls
     * to avoid allocation; cleared at the start of each walk.
     */
    private _fullSyncVisited: Set<ChangeTree> = new Set();

    encode(
        it: Iterator = { offset: 0 },
        view?: StateView,
        buffer: Uint8Array = this.sharedBuffer,
        changeSetName: ChangeSetName = "changes",
        initialOffset = it.offset // cache current offset in case we need to resize the buffer
    ): Uint8Array {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        const ctx = this._encodeCtx;
        ctx.self = this;
        ctx.buffer = buffer;
        ctx.it = it;
        ctx.view = view;
        ctx.isEncodeAll = false;
        ctx.hasView = hasView;

        let current: ChangeTreeList | ChangeTreeNode = this.root[changeSetName];

        while (current = current.next) {
            const changeTree = (current as ChangeTreeNode).changeTree;

            if (hasView) {
                if (!view.isChangeTreeVisible(changeTree)) {
                    view.invisible.add(changeTree);
                    continue; // skip this change tree
                }
                view.invisible.delete(changeTree); // remove from invisible list
            }

            const ref = changeTree.ref;
            const recorder = changeTree.recorder;

            if (!recorder.has(changeSetName)) { continue; }

            const ctor = ref.constructor;

            // skip root `refId` if it's the first change tree
            // (unless it "hasView", which will need to revisit the root)
            if (hasView || it.offset > initialOffset || changeTree !== rootChangeTree) {
                buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(buffer, ref[$refId], it);
            }

            ctx.changeTree = changeTree;
            ctx.ref = ref;
            ctx.encoder = ctor[$encoder];
            ctx.filter = ctor[$filter];
            ctx.metadata = ctor[Symbol.metadata];

            recorder.forEachWithCtx(changeSetName, ctx, encodeChangeCb);
        }

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeAndRetryEncode(buffer, it.offset, initialOffset, view, changeSetName);
            return this.encode({ offset: initialOffset }, view, buffer, changeSetName);
        }

        return buffer.subarray(0, it.offset);
    }

    /**
     * Structural DFS walker for full-sync (encodeAll / encodeAllView).
     * Visits each ChangeTree in DFS preorder starting from the state root,
     * emitting ADD operations for every currently-populated index via
     * {@link ChangeTree.forEachLive}.
     *
     * `emitFiltered` selects which subset of trees to emit:
     *  - false → only unfiltered trees (encodeAll baseline)
     *  - true  → only filtered trees (encodeAllView per-view layer)
     */
    private encodeFullSync(
        it: Iterator,
        buffer: Uint8Array,
        emitFiltered: boolean,
        view?: StateView,
        initialOffset: number = it.offset
    ): Uint8Array {
        const hasView = (view !== undefined);
        const rootChangeTree = this.state[$changes];

        const ctx = this._encodeCtx;
        ctx.self = this;
        ctx.buffer = buffer;
        ctx.it = it;
        ctx.view = view;
        ctx.isEncodeAll = true;
        ctx.hasView = hasView;

        const visited = this._fullSyncVisited;
        visited.clear();

        const walk = (changeTree: ChangeTree): void => {
            if (visited.has(changeTree)) return;
            visited.add(changeTree);

            const ref = changeTree.ref;
            const ctor = ref.constructor;
            const metadata = ctor[Symbol.metadata];

            // Visibility gate: when a view is active, a non-visible tree
            // contributes nothing itself but we still recurse so descendants
            // (which may have been explicitly view.add()-ed) are reachable.
            let visibleHere = true;
            if (hasView) {
                if (!view.isChangeTreeVisible(changeTree)) {
                    view.invisible.add(changeTree);
                    visibleHere = false;
                } else {
                    view.invisible.delete(changeTree);
                }
            }

            // Filter classification (must match ChangeTree.change()):
            // a given (tree, index) is filtered iff tree.isFiltered (inherited
            // from a filtered ancestor) OR the field itself has a @view tag.
            // - Schema trees: per-field if tree.isFiltered is false, else all fields.
            // - Collection trees: tree-wide via hasFilteredChanges.
            const isSchema = Metadata.isValidInstance(ref);
            const treeIsFiltered = changeTree.isFiltered;
            const collectionIsFiltered = !isSchema && changeTree.hasFilteredChanges;

            let emitFields = visibleHere;
            if (emitFields && !isSchema) {
                emitFields = collectionIsFiltered === emitFiltered;
            }

            let structSwitchEmitted = false;
            const ensureStructSwitch = () => {
                if (structSwitchEmitted) return;
                if (hasView || ctx.it.offset > initialOffset || changeTree !== rootChangeTree) {
                    ctx.buffer[ctx.it.offset++] = SWITCH_TO_STRUCTURE & 255;
                    encode.number(ctx.buffer, ref[$refId], ctx.it);
                }
                ctx.changeTree = changeTree;
                ctx.ref = ref;
                ctx.encoder = ctor[$encoder];
                ctx.filter = ctor[$filter];
                ctx.metadata = metadata;
                structSwitchEmitted = true;
            };

            if (emitFields) {
                changeTree.forEachLive((index) => {
                    if (isSchema) {
                        // Same filtered-index rule as ChangeTree.change().
                        const fieldFiltered = treeIsFiltered || (metadata?.[index]?.tag !== undefined);
                        if (fieldFiltered !== emitFiltered) return;
                    }
                    ensureStructSwitch();
                    encodeChangeCb(ctx, index, OPERATION.ADD);
                });
            }

            changeTree.forEachChild((child, _) => walk(child));
        };

        walk(rootChangeTree);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeAndRetryEncode(buffer, it.offset, initialOffset, view, undefined);
            return this.encodeFullSync({ offset: initialOffset }, buffer, emitFiltered, view);
        }

        return buffer.subarray(0, it.offset);
    }

    private _resizeAndRetryEncode(
        buffer: Uint8Array,
        usedOffset: number,
        _initialOffset: number,
        _view: StateView | undefined,
        _changeSetName: ChangeSetName | undefined,
    ): Uint8Array {
        const newSize = Math.ceil(usedOffset / Encoder.BUFFER_SIZE) * Encoder.BUFFER_SIZE;

        console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(buffer);

        // assign resized buffer to local sharedBuffer
        if (buffer === this.sharedBuffer) {
            this.sharedBuffer = newBuffer;
        }

        return newBuffer;
    }

    encodeAll(
        it: Iterator = { offset: 0 },
        buffer: Uint8Array = this.sharedBuffer
    ) {
        return this.encodeFullSync(it, buffer, /* emitFiltered */ false);
    }

    encodeAllView(
        view: StateView,
        sharedOffset: number,
        it: Iterator,
        bytes: Uint8Array = this.sharedBuffer
    ) {
        const viewOffset = it.offset;

        // try to encode "filtered" changes
        this.encodeFullSync(it, bytes, /* emitFiltered */ true, view, viewOffset);

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

        // encode visibility changes (add/remove for this view)
        for (const [refId, changes] of view.changes) {
            const changeTree: ChangeTree = this.root.changeTrees[refId];

            if (changeTree === undefined) {
                // detached instance, remove from view and skip.
                view.changes.delete(refId);
                continue;
            }

            const keys = Object.keys(changes);
            if (keys.length === 0) {
                // FIXME: avoid having empty changes if no changes were made
                continue;
            }

            const ref = changeTree.ref;

            const ctor = ref.constructor;
            const encoder = ctor[$encoder];
            const metadata = ctor[Symbol.metadata];

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

        // try to encode "filtered" changes
        this.encode(it, view, bytes, "filteredChanges", viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
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
        if (this.root.filteredChanges) {
            current = this.root.filteredChanges.next;
            while (current) {
                current.changeTree.endEncode('filteredChanges');
                current = current.next;
            }
            this.root.filteredChanges = createChangeTreeList();
        }
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
            this.root.filteredChanges?.next !== undefined
        );
    }
}
