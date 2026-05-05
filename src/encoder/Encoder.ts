import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $changes, $getByIndex, $refId } from "../types/symbols.js";
import { Metadata } from "../Metadata.js";

import { encode } from "../encoding/encode.js";
import type { Iterator } from "../encoding/decode.js";

import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec.js';
import { Root } from "./Root.js";

import type { StateView } from "./StateView.js";
import type { ChangeTree, ChangeTreeList, ChangeTreeNode } from "./ChangeTree.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import { forEachLiveWithCtx as _forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import { forEachChildWithCtx as _forEachChildWithCtx } from "./changeTree/treeAttachment.js";

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
     * Current walk's visit stamp. `_fullSyncWalk` compares it against each
     * tree's `_fullSyncGen` on entry: match means "already visited by
     * this walk, skip"; mismatch means "first visit, stamp and recurse".
     * Rewritten per walk by `encodeFullSync` before kicking off the DFS.
     */
    gen: number;
    /** Initial buffer offset at encodeFullSync entry — used by the walker to
     *  decide whether to emit SWITCH_TO_STRUCTURE for the root tree. */
    initialOffset: number;
    rootChangeTree: ChangeTree;

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
 * Module-level adapter for `forEachLiveWithCtx`. Full-sync emits every live
 * field as ADD, so we re-enter `encodeChangeCb` with that fixed op — keeps
 * the callback closure-free across the entire DFS walk.
 */
function encodeFullSyncCb(ctx: EncodeCtx, fieldIndex: number): void {
    encodeChangeCb(ctx, fieldIndex, OPERATION.ADD);
}

/**
 * Structural DFS walker for `encodeFullSync`. Hoisted to module scope so
 * the recursion allocates no per-tree closures — `_fullSyncWalkChildCb`
 * captures nothing and is handed to `forEachChildWithCtx` once.
 *
 * The stamp check at the top (`tree._fullSyncGen === ctx.gen`) is how we
 * skip shared refs that are reachable through more than one parent. On
 * first visit the tree's stamp differs from the walk's current `ctx.gen`;
 * we write `ctx.gen` onto the tree and recurse. Any later reach of the
 * same tree during the SAME walk will find matching stamps and bail.
 * Next walk bumps `ctx.gen`, so every tree starts out stale again.
 */
function _fullSyncWalk(ctx: EncodeCtx, changeTree: ChangeTree): void {
    if (changeTree._fullSyncGen === ctx.gen) return;
    changeTree._fullSyncGen = ctx.gen;

    // Visibility gate: when a view is active, a non-visible tree contributes
    // nothing itself but we still recurse so descendants (possibly added to
    // the view explicitly) are reachable.
    let visibleHere = true;
    if (ctx.hasView) {
        const view = ctx.view!;
        if (!view.isChangeTreeVisible(changeTree)) {
            view.markInvisible(changeTree);
            visibleHere = false;
        } else {
            view.unmarkInvisible(changeTree);
        }
    }

    if (visibleHere) {
        const desc = changeTree.encDescriptor;
        ctx.changeTree = changeTree;
        ctx.ref = changeTree.ref;
        ctx.encoder = desc.encoder;
        ctx.filter = desc.filter;
        ctx.metadata = desc.metadata;
        ctx.treeIsFiltered = changeTree.isFiltered;
        ctx.isSchema = desc.isSchema;
        ctx.filterBitmask = desc.filterBitmask;
        ctx.structSwitchEmitted = false;
        ctx.shouldEmitSwitch = (ctx.hasView || ctx.it.offset > ctx.initialOffset || changeTree !== ctx.rootChangeTree);

        // Call the module function directly — the `forEachLiveWithCtx`
        // method on ChangeTree is a pass-through that V8 doesn't inline
        // under the polymorphism the encoder sees (Schema + every
        // collection class share the method slot). Direct call saves the
        // dispatched frame.
        _forEachLiveWithCtx(changeTree, ctx, encodeFullSyncCb);
    }

    _forEachChildWithCtx(changeTree, ctx, _fullSyncWalkChildCb);
}

/**
 * Child-iteration callback for `_fullSyncWalk`. Module-level + closure-free:
 * just re-enters `_fullSyncWalk` on each child. Replaces a per-tree
 * `(child, _) => walk(child)` closure that used to allocate 2.5M times in
 * `encodeAll(5000 entities) x 500 iterations`.
 */
function _fullSyncWalkChildCb(ctx: EncodeCtx, child: ChangeTree, _index: any): void {
    _fullSyncWalk(ctx, child);
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
        gen: 0, initialOffset: 0, rootChangeTree: undefined!,
    };

    /**
     * Monotonic counter bumped at the start of every `encodeFullSync`
     * call. The new value is copied to `ctx.gen` and stamped into every
     * tree the walk touches (`tree._fullSyncGen = ctx.gen`); subsequent
     * revisits of the same tree detect the equality and return early.
     */
    private _fullSyncGen: number = 0;

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
                    view.markInvisible(changeTree);
                    continue;
                }
                view.unmarkInvisible(changeTree);
            }

            const recorder = unreliable ? changeTree.unreliableRecorder : changeTree;
            if (!recorder || !recorder.has()) { continue; }

            const desc = changeTree.encDescriptor;
            ctx.changeTree = changeTree;
            ctx.ref = changeTree.ref;
            ctx.encoder = desc.encoder;
            ctx.filter = desc.filter;
            ctx.metadata = desc.metadata;
            ctx.treeIsFiltered = changeTree.isFiltered;
            ctx.isSchema = desc.isSchema;
            ctx.filterBitmask = desc.filterBitmask;
            ctx.structSwitchEmitted = false;
            ctx.isRootTree = (changeTree === rootChangeTree);
            // Root's struct switch is skipped at the very start of the shared
            // pass (matches the legacy wire protocol). In view pass or after
            // the first emission, always emit the switch.
            ctx.shouldEmitSwitch = (hasView || it.offset > initialOffset || !ctx.isRootTree);

            recorder.forEachWithCtx(ctx, encodeChangeCb);
        }

        // Broadcast-mode stream emission runs after the main loop (state /
        // parent refs are already on the wire, so stream ADD ops can
        // reference element refIds safely). Reliable shared pass only;
        // skipped when any StateView is registered (priority pass in
        // `encodeView` owns emission in that mode).
        if (!unreliable && !hasView && this.root.activeViews.size === 0 && this.root.streamTrees.size > 0) {
            this._emitStreamBroadcast(buffer, it);
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

        // Bump the generation counter and carry the new value on `ctx` so
        // the recursive walker can stamp every tree it visits. Any tree
        // still holding the previous walk's stamp is treated as unvisited
        // on first reach, and stamped; a second reach (shared ref via
        // multiple parents) sees the match and bails.
        ctx.gen = ++this._fullSyncGen;
        ctx.initialOffset = initialOffset;
        ctx.rootChangeTree = rootChangeTree;
        _fullSyncWalk(ctx, rootChangeTree);

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

        // Stream priority pass: drain up to `maxPerTick` per-view entries
        // from every registered stream before draining view.changes. Each
        // selected element is passed to `view.add()` which populates
        // view.changes with the stream-link ADD + element-field ADDs.
        this._emitStreamPriority(view);

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
                view.changes.delete(refId);
                continue;
            }

            if (changes.size === 0) {
                continue;
            }

            const desc = changeTree.encDescriptor;
            const encoder = desc.encoder;
            const metadata = desc.metadata;
            // `ref` → user-facing identity (Proxy on ArraySchema), used for
            // `[$refId]`. `refTarget` → raw instance, used for the hot
            // `[$getByIndex]` lookup that runs once per change.
            const ref = changeTree.ref;
            const refTarget = changeTree.refTarget;

            bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
            encode.number(bytes, ref[$refId], it);

            // Iterate entries directly — the inner Map gives us the (index, op)
            // pair without an intermediate keys array or Number() parse.
            for (const [index, op] of changes) {
                // workaround when using view.add() on item that has been deleted from state
                // (see test "adding to view item that has been removed from state")
                const value = refTarget[$getByIndex](index);
                const operation = (value !== undefined && op) || OPERATION.DELETE;

                // isEncodeAll = false, hasView = true
                encoder(this, bytes, changeTree, index, operation, it, false, true, metadata);
            }
        }

        //
        // TODO: only clear view changes after all views are encoded
        // (to allow re-using StateView's for multiple clients)
        //
        view.changes.clear();
        view.changesOutOfOrder = false;

        // per-tick view-scoped pass: walks the same `changes` queue as the
        // shared pass, but `encodeChangeCb` emits only filtered fields.
        this.encode(it, view, bytes, viewOffset);

        return concatBytes(
            bytes.subarray(0, sharedOffset),
            bytes.subarray(viewOffset, it.offset)
        );
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
                // Primary parent
                const primary = changeTree.parentRef;
                if (primary !== undefined) {
                    const parentRefId = primary[$refId];
                    if (parentRefId !== undefined && view.changes.has(parentRefId)) {
                        visit(parentRefId);
                    }
                }
                // Extra parents linked list (rare: instance sharing)
                let chain = changeTree.extraParents;
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

    /**
     * Broadcast-mode counterpart to `_emitStreamPriority`. Runs when NO
     * StateViews are registered — streams fall back to broadcast mode
     * where up to `maxPerTick` pending ADDs per stream emit to ALL clients
     * each shared tick. DELETEs always flush (no cap).
     *
     * Emits directly to the shared-encode buffer: stream & element trees
     * are `isFiltered=true` so the main loop would otherwise skip them.
     * Runs AFTER the main loop so state / parent refs are already encoded
     * — stream ADD ops reference element refIds, which must be decodable.
     */
    private _emitStreamBroadcast(buffer: Uint8Array, it: Iterator): void {
        const streams = this.root.streamTrees;
        for (const stream of streams) {
            const s: any = stream;
            const tree: ChangeTree = s[$changes];
            // Stream is registered with Root but not yet assigned a refId
            // (e.g. created but never attached to state). Skip.
            const streamRefId = s[$refId];
            if (streamRefId === undefined) continue;

            // `inheritedFlags.ensureStreamState` allocates `_stream` the
            // moment the tree picks up `isStreamCollection` — Root only
            // tracks trees that reached that point, so `_stream` is
            // guaranteed defined here.
            const st = s._stream!;
            const deletes: Set<number> = st.broadcastDeletes;
            const pending: Set<number> = st.broadcastPending;
            const sent: Set<number> = st.sentBroadcast;
            const hasDeletes = deletes.size > 0;
            const hasAdds = pending.size > 0;

            const desc = tree.encDescriptor;
            const streamEncoder = desc.encoder;
            const streamMetadata = desc.metadata;

            // Emit stream ADD/DELETE ops for this tick, if any.
            if (hasDeletes || hasAdds) {
                buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(buffer, streamRefId, it);

                // DELETEs first (flush all).
                if (hasDeletes) {
                    for (const pos of deletes) {
                        streamEncoder(this, buffer, tree, pos, OPERATION.DELETE, it, false, false, streamMetadata);
                    }
                    deletes.clear();
                }

                // ADDs up to maxPerTick.
                const max: number = st.maxPerTick;
                const emittedElements: any[] = [];
                let count = 0;
                const toDelete: number[] = [];
                for (const pos of pending) {
                    if (count >= max) break;
                    // `$getByIndex` works for any streamable collection:
                    // StreamSchema (Map<number, V>) and MapSchema (string-keyed
                    // via journal index) both route through the same symbol.
                    const element = s[$getByIndex](pos);
                    if (element === undefined) {
                        toDelete.push(pos);
                        continue;
                    }
                    streamEncoder(this, buffer, tree, pos, OPERATION.ADD, it, false, false, streamMetadata);
                    sent.add(pos);
                    emittedElements.push(element);
                    toDelete.push(pos);
                    count++;
                }
                for (const pos of toDelete) pending.delete(pos);

                // Emit each element's full state — forEachLive walks populated
                // fields structurally, mirroring encodeAllView's bootstrap.
                // Covers both static elements (dirty state was reset by
                // inheritedFlags' becameStatic branch) and non-static (still
                // has dirty state but the main loop skipped them because
                // they're filtered).
                for (const element of emittedElements) {
                    const elTree: ChangeTree | undefined = element[$changes];
                    if (elTree === undefined) continue;
                    const elRefId = element[$refId];
                    if (elRefId === undefined) continue;

                    buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                    encode.number(buffer, elRefId, it);

                    const elDesc = elTree.encDescriptor;
                    const elEncoder = elDesc.encoder;
                    const elMetadata = elDesc.metadata;
                    elTree.forEachLive((idx: number) => {
                        // @unreliable fields ship on the unreliable channel only.
                        if (Metadata.hasUnreliableAtIndex(elMetadata, idx)) return;
                        elEncoder(this, buffer, elTree, idx, OPERATION.ADD, it, false, false, elMetadata);
                    });
                }
            }

            // Emit mutation updates for already-sent elements. Element
            // trees are `isFiltered=true` (inherited from stream field),
            // so the main loop skips them. We pick up their dirty state
            // here so broadcast mode sees post-send field mutations.
            for (const pos of sent) {
                const element = s[$getByIndex](pos);
                if (element === undefined) continue;
                const elTree: ChangeTree | undefined = element[$changes];
                if (elTree === undefined || !elTree.has()) continue;

                const elRefId = element[$refId];
                if (elRefId === undefined) continue;

                buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                encode.number(buffer, elRefId, it);

                const elDesc = elTree.encDescriptor;
                const elEncoder = elDesc.encoder;
                const elMetadata = elDesc.metadata;
                elTree.forEach((idx: number, op: OPERATION) => {
                    if (idx < 0) return; // pure ops (collection only)
                    if (Metadata.hasUnreliableAtIndex(elMetadata, idx)) return;
                    elEncoder(this, buffer, elTree, idx, op, it, false, false, elMetadata);
                });
            }
        }
    }

    /**
     * Walk every registered stream, pick up to `maxPerTick` positions from
     * this view's pending backlog (priority-sorted when the view supplies a
     * `streamPriority` callback), and hand each element to `view.add()`.
     * `view.add()` seeds `view.changes` so the subsequent drain emits both
     * the stream-link (position → refId) and the element's field data.
     *
     * Designed to run at the very top of `encodeView`, BEFORE the
     * view.changes drain loop.
     */
    private _emitStreamPriority(view: StateView): void {
        const streams = this.root.streamTrees;
        if (streams.size === 0) return;

        const viewId = view.id;

        for (const stream of streams) {
            const s: any = stream;
            // Guaranteed non-undefined: `inheritedFlags.ensureStreamState`
            // runs before Root.registerStream.
            const st = s._stream!;
            const pending: Set<number> | undefined = st.pendingByView.get(viewId);
            if (pending === undefined || pending.size === 0) continue;

            // Per-stream priority callback: declared at schema time (via
            // `t.stream(X).priority(fn)` or the decorator form) and seeded
            // into `_stream.priority` when the stream was attached. Users
            // can also override per-instance by assigning to the setter.
            const priority = st.priority;

            // Materialize pending into an array so we can sort + slice.
            // Small sets (typical: tens to low hundreds) — allocation is
            // negligible compared to the priority sort and element walk.
            const positions: number[] = [];
            for (const p of pending) positions.push(p);

            if (priority !== undefined) {
                // Use the symbol-keyed accessor so Map/Set/Stream all route
                // through the same lookup regardless of $items layout.
                positions.sort(
                    (a: number, b: number) => priority(view, s[$getByIndex](b)) - priority(view, s[$getByIndex](a)),
                );
            }

            const max = st.maxPerTick;
            const count = Math.min(positions.length, max);

            let sent: Set<number> | undefined = st.sentByView.get(viewId);
            if (sent === undefined) {
                sent = new Set();
                st.sentByView.set(viewId, sent);
            }

            for (let i = 0; i < count; i++) {
                const pos = positions[i];
                const element = s[$getByIndex](pos);
                if (element === undefined) {
                    // Element was removed after being queued but before emit.
                    pending.delete(pos);
                    continue;
                }
                // `_addImmediate` force-ships the element through view.changes
                // (markVisible + addParentOf + forEachChild recursion) WITHOUT
                // routing stream elements back into pending — we're already
                // draining pending here, so the normal `add()` path would
                // infinite-loop. addParentOf seeds
                // `view.changes[stream.refId][pos] = ADD` (stream-link emit).
                view._addImmediate(element);
                // Force-seed element fields even when view.add skipped
                // forEachLive (isNew && !isChildAdded). Matches the
                // bootstrap emission encodeAllView does for filtered
                // refs. `@unreliable` fields are excluded — they ship
                // on the unreliable channel and force-seeding here
                // would leak onto the reliable view pass.
                const elTree = element[$changes];
                if (elTree !== undefined) {
                    const elRefId = element[$refId];
                    let elChanges = view.changes.get(elRefId);
                    if (elChanges === undefined) {
                        elChanges = new Map();
                        view.changes.set(elRefId, elChanges);
                    }
                    const elMetadata = elTree.metadata;
                    elTree.forEachLive((index: number) => {
                        if (Metadata.hasUnreliableAtIndex(elMetadata, index)) return;
                        elChanges!.set(index, OPERATION.ADD);
                    });
                }
                pending.delete(pos);
                sent.add(pos);
            }
        }
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

        // End-of-tick: refIds released during this tick have now had their
        // DELETEs emitted through `encode()` / `encodeView()`, so they are
        // safe to recycle on the next tick.
        root.refIds.flushReleases();
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
