import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { Metadata } from "../Metadata.js";
import { $changes, $encoder, $filter, $filterBitmask, $getByIndex, $refId, $viewFieldIndexes } from "../types/symbols.js";

import { encode } from "../encoding/encode.js";
import type { Iterator } from "../encoding/decode.js";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec.js';
import { Root } from "./Root.js";

import type { StateView } from "./StateView.js";
import type { ChangeTree, ChangeTreeList, ChangeTreeNode } from "./ChangeTree.js";
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

    /**
     * Per-tree flags, reset before each `forEachWithCtx` call. The per-field
     * filter decision (`emitFiltered` == `treeIsFiltered || metadata[i].tag`)
     * matches `ChangeTree.change()`'s routing rule exactly.
     */
    treeIsFiltered: boolean;
    isSchema: boolean;
    emitFiltered: boolean;

    /**
     * Bitmask: bit i set iff field i has a @view tag. Lets the per-field
     * filter check be a single bitwise op instead of a metadata[i]?.tag chase.
     * Always 0 for collection trees.
     */
    filterBitmask: number;

    /**
     * Lazy structure-switch state. The switch header is emitted right before
     * the first field of a tree actually passes the filter, so trees that
     * contribute zero bytes in a given pass don't leave orphaned headers.
     */
    structSwitchEmitted: boolean;
    isRootTree: boolean;
    shouldEmitSwitch: boolean;
}

/**
 * Per-Schema-class bitmask of @view-tagged fields. Lazy-computed from
 * metadata[$viewFieldIndexes] the first time a tree of this class is
 * encoded; cached on the metadata object so subsequent encodes are O(1).
 */
function getFilterBitmask(metadata: any): number {
    if (metadata === undefined) return 0;
    let bm: number | undefined = metadata[$filterBitmask];
    if (bm !== undefined) return bm;
    bm = 0;
    const tagged = metadata[$viewFieldIndexes];
    if (tagged !== undefined) {
        for (let i = 0, len = tagged.length; i < len; i++) bm |= (1 << tagged[i]);
    }
    // Non-enumerable so `for (const k in metadata)` iteration in TypeContext
    // and elsewhere doesn't mistake this cache for a real field index.
    Object.defineProperty(metadata, $filterBitmask, {
        value: bm,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return bm;
}

/**
 * Emit the lazy structure-switch header (SWITCH_TO_STRUCTURE + refId) for
 * the current tree if it hasn't been emitted yet in this pass.
 */
function ensureStructSwitch(ctx: EncodeCtx): void {
    if (ctx.structSwitchEmitted) return;
    if (ctx.shouldEmitSwitch) {
        ctx.buffer[ctx.it.offset++] = SWITCH_TO_STRUCTURE & 255;
        encode.number(ctx.buffer, ctx.ref[$refId], ctx.it);
    }
    ctx.structSwitchEmitted = true;
}

/**
 * Pure (non-capturing) callback for recorder.forEachWithCtx. Module-level so
 * V8 never needs to allocate a fresh function per tree. Decides per-field
 * whether to emit based on the unified filter rule, then defers to the
 * per-type encode function.
 */
function encodeChangeCb(ctx: EncodeCtx, fieldIndex: number, op: OPERATION): void {
    if (fieldIndex < 0) {
        // Pure op (CLEAR/REVERSE): encoded as a single byte. Always emitted
        // for the pass that matches the tree's filter classification —
        // collections route pure ops to their single dirty bucket.
        if (ctx.treeIsFiltered !== ctx.emitFiltered) return;
        ensureStructSwitch(ctx);
        ctx.buffer[ctx.it.offset++] = Math.abs(fieldIndex) & 255;
        return;
    }

    // Per-field filter decision (same rule as ChangeTree.change()):
    // a field is filtered iff the tree inherits isFiltered OR the field
    // itself carries a @view tag. Schema trees check via the precomputed
    // bitmask; collection trees inherit tree-level (bitmask is 0).
    const fieldFiltered = ctx.isSchema
        ? (ctx.treeIsFiltered || (ctx.filterBitmask & (1 << fieldIndex)) !== 0)
        : ctx.treeIsFiltered;
    if (fieldFiltered !== ctx.emitFiltered) return;

    const operation = ctx.isEncodeAll ? OPERATION.ADD : op;
    if (operation === undefined) return;
    if (ctx.filter !== undefined && !ctx.filter(ctx.ref, fieldIndex, ctx.view)) return;

    ensureStructSwitch(ctx);
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

    private _encodeCtx: EncodeCtx = {
        self: undefined!, buffer: undefined!, it: undefined!, changeTree: undefined!,
        ref: undefined, encoder: undefined!, filter: undefined, metadata: undefined,
        view: undefined, isEncodeAll: false, hasView: false,
        treeIsFiltered: false, isSchema: false, emitFiltered: false,
        filterBitmask: 0,
        structSwitchEmitted: false, isRootTree: false, shouldEmitSwitch: false,
    };

    /** Dedupe set reused across full-sync walks to avoid allocation. */
    private _fullSyncVisited: Set<ChangeTree> = new Set();

    encode(
        it: Iterator = { offset: 0 },
        view?: StateView,
        buffer: Uint8Array = this.sharedBuffer,
        initialOffset = it.offset
    ): Uint8Array {
        return this._encodeChannel(it, view, buffer, initialOffset, /* unreliable */ false);
    }

    /**
     * Per-tick encode of the UNRELIABLE channel. Walks `root.unreliableChanges`
     * and emits each tree's `unreliableRecorder`. Safe to call at a different
     * cadence than `encode()` (e.g. 60Hz vs 20Hz) — the two channels are
     * fully independent.
     */
    encodeUnreliable(
        it: Iterator = { offset: 0 },
        view?: StateView,
        buffer: Uint8Array = this.sharedBuffer,
        initialOffset = it.offset
    ): Uint8Array {
        return this._encodeChannel(it, view, buffer, initialOffset, /* unreliable */ true);
    }

    private _encodeChannel(
        it: Iterator,
        view: StateView | undefined,
        buffer: Uint8Array,
        initialOffset: number,
        unreliable: boolean,
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
        // Shared pass (no view): emit unfiltered fields. View pass: emit
        // filtered fields only. Fields on the other side of the split are
        // skipped inside encodeChangeCb.
        ctx.emitFiltered = hasView;

        const queue: ChangeTreeList = unreliable ? this.root.unreliableChanges : this.root.changes;
        let current: ChangeTreeList | ChangeTreeNode = queue;

        while (current = current.next) {
            const changeTree = (current as ChangeTreeNode).changeTree;

            if (hasView) {
                if (!view.isChangeTreeVisible(changeTree)) {
                    view.invisible.add(changeTree);
                    continue;
                }
                view.invisible.delete(changeTree);
            }

            const recorder = unreliable ? changeTree.unreliableRecorder : changeTree.recorder;
            if (!recorder || !recorder.has()) { continue; }

            const ref = changeTree.ref;
            const ctor = ref.constructor;

            ctx.changeTree = changeTree;
            ctx.ref = ref;
            ctx.encoder = ctor[$encoder];
            ctx.filter = ctor[$filter];
            const md = ctor[Symbol.metadata];
            ctx.metadata = md;
            ctx.treeIsFiltered = changeTree.isFiltered;
            ctx.isSchema = Metadata.isValidInstance(ref);
            ctx.filterBitmask = ctx.isSchema ? getFilterBitmask(md) : 0;
            ctx.structSwitchEmitted = false;
            ctx.isRootTree = (changeTree === rootChangeTree);
            // Root's struct switch is skipped at the very start of the shared
            // pass (matches the legacy wire protocol). In view pass or after
            // the first emission, always emit the switch.
            ctx.shouldEmitSwitch = (hasView || it.offset > initialOffset || !ctx.isRootTree);

            recorder.forEachWithCtx(ctx, encodeChangeCb);
        }

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            return this._encodeChannel({ offset: initialOffset }, view, buffer, initialOffset, unreliable);
        }

        return buffer.subarray(0, it.offset);
    }

    /**
     * Structural DFS walker for full-sync (encodeAll / encodeAllView).
     * Visits each ChangeTree in DFS preorder starting from the state root,
     * emitting ADD operations for every currently-populated index via
     * {@link ChangeTree.forEachLive}.
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
        ctx.emitFiltered = emitFiltered;

        const visited = this._fullSyncVisited;
        visited.clear();

        const walk = (changeTree: ChangeTree): void => {
            if (visited.has(changeTree)) return;
            visited.add(changeTree);

            const ref = changeTree.ref;
            const ctor = ref.constructor;

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

            if (visibleHere) {
                ctx.changeTree = changeTree;
                ctx.ref = ref;
                ctx.encoder = ctor[$encoder];
                ctx.filter = ctor[$filter];
                const md = ctor[Symbol.metadata];
                ctx.metadata = md;
                ctx.treeIsFiltered = changeTree.isFiltered;
                ctx.isSchema = Metadata.isValidInstance(ref);
                ctx.filterBitmask = ctx.isSchema ? getFilterBitmask(md) : 0;
                ctx.structSwitchEmitted = false;
                ctx.shouldEmitSwitch = (hasView || ctx.it.offset > initialOffset || changeTree !== rootChangeTree);

                changeTree.forEachLive((index) => {
                    encodeChangeCb(ctx, index, OPERATION.ADD);
                });
            }

            changeTree.forEachChild((child, _) => walk(child));
        };

        walk(rootChangeTree);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            return this.encodeFullSync({ offset: initialOffset }, buffer, emitFiltered, view);
        }

        return buffer.subarray(0, it.offset);
    }

    private _resizeBuffer(buffer: Uint8Array, usedOffset: number): Uint8Array {
        const newSize = Math.ceil(usedOffset / Encoder.BUFFER_SIZE) * Encoder.BUFFER_SIZE;

        console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(buffer);

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

        // encode visibility-triggered changes collected by view.add()
        for (const [refId, changes] of view.changes) {
            const changeTree: ChangeTree = this.root.changeTrees[refId];

            if (changeTree === undefined) {
                // detached instance, remove from view and skip.
                view.changes.delete(refId);
                continue;
            }

            const keys = Object.keys(changes);
            if (keys.length === 0) {
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

                // isEncodeAll = false, hasView = true
                encoder(this, bytes, changeTree, index, operation, it, false, true, metadata);
            }
        }

        //
        // TODO: only clear view changes after all views are encoded
        // (to allow re-using StateView's for multiple clients)
        //
        view.changes.clear();

        // per-tick view-scoped pass: walks the same `changes` queue as the
        // shared pass, but `encodeChangeCb` emits only filtered fields.
        this.encode(it, view, bytes, viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
    }

    /**
     * Per-view unreliable encode. Walks `root.unreliableChanges` and emits
     * only filtered fields visible to this view. Unlike `encodeView`, this
     * doesn't emit `view.changes` entries — those are used only for
     * reliable view bootstrap (membership ADDs) and are consumed by
     * `encodeView` on the reliable channel.
     */
    encodeUnreliableView(
        view: StateView,
        sharedOffset: number,
        it: Iterator,
        bytes: Uint8Array = this.sharedBuffer
    ) {
        const viewOffset = it.offset;

        this.encodeUnreliable(it, view, bytes, viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
    }

    discardChanges() {
        const list = this.root.changes;
        let current = list.next;
        const root = this.root;
        while (current) {
            const next = current.next;
            current.changeTree.endEncode(); // clears changesNode internally
            root.releaseNode(current);
            current = next;
        }
        list.next = undefined;
        list.tail = undefined;
    }

    discardUnreliableChanges() {
        const list = this.root.unreliableChanges;
        let current = list.next;
        const root = this.root;
        while (current) {
            const next = current.next;
            current.changeTree.endEncodeUnreliable(); // clears unreliableChangesNode internally
            root.releaseNode(current);
            current = next;
        }
        list.next = undefined;
        list.tail = undefined;
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
        return this.root.changes.next !== undefined;
    }

    get hasUnreliableChanges() {
        return this.root.unreliableChanges.next !== undefined;
    }
}
