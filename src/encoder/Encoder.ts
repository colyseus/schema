import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $childType, $getByIndex } from "../types/symbols.js";
import type { Iterator } from "../encoding/decode.js";
import { KIND_ARRAY, OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { Root } from "./Root.js";
import type { StateView } from "./StateView.js";
import { IS_FILTERED, IS_NEW, type ChangeTree, type ChangeTreeList, type ChangeTreeNode, refTreeOf, refIdOf } from "./ChangeTree.js";
import type { SchemaChangeRecorder } from "./ChangeRecorder.js";
import { forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import { forEachChildWithCtx } from "./changeTree/treeAttachment.js";
import { drainFilterRefresh } from "./changeTree/inheritedFlags.js";
import {
    MODE_DRAIN, MODE_PATCH, MODE_SNAPSHOT, MODE_STREAM,
    closeChunk, emitKeyedOp, emitLiveChunk, emitViewEntry, encodeKeyedOps, encodeSchemaBits, encodeSchemaOps, encodeTreeOps,
    enterFrame, openChunk, passFrame, releaseFrames, writeChunkHeader, type Frame,
    runEligible, runContinues, openRun, addRunMember, endRun,
} from "./EncodeOperation.js";

/**
 * Grow an encoder's output buffer to the next `BUFFER_SIZE` multiple that
 * fits `usedOffset` bytes, warning once with the value to configure.
 */
export function growSharedBuffer(owner: { sharedBuffer: Uint8Array }, buffer: Uint8Array, usedOffset: number): Uint8Array {
    const newSize = Math.ceil(usedOffset / Encoder.BUFFER_SIZE) * Encoder.BUFFER_SIZE;

    console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);

    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(buffer);

    if (buffer === owner.sharedBuffer) {
        owner.sharedBuffer = newBuffer;
    }

    return newBuffer;
}

/** End the tick for every tree in `list`: reset recorders, release queue nodes. */
export function discardQueue(root: Root, list: ChangeTreeList): void {
    let current = list.next;
    while (current) {
        const next = current.next;
        current.changeTree.endEncode(); // clears changesNode internally
        root.releaseNode(current);
        current = next;
    }
    list.next = undefined;
    list.tail = undefined;
}

/**
 * Wire-format encoder.
 *
 * - `encodeAll` / `encodeAllView`: full sync — one nested root chunk with
 *   fresh instances inlined as bodies.
 * - `encode` / `encodeView`: per-tick patch — one chunk per dirty tree
 *   (`uvarint(refId) uvarint(len) ops`), fresh instances inlined as bodies
 *   of the parent's ADD.
 * - `encodeUnreliable` / `encodeUnreliableView`: the `@unreliable` channel.
 * - The view variants return `[shared, viewSlice]` — two views into the
 *   shared buffer, no per-client concat; `Encoder.concat` joins them for
 *   single-buffer transports.
 */
const EMPTY_SLICE = new Uint8Array(0);

export class Encoder<T extends Schema = any> {
    /**
     * Per-encoder shared output buffer size. The encoder auto-grows on
     * overflow and logs a one-time warning suggesting a higher value, so
     * the default just needs to comfortably cover typical room state.
     * Raise per app via `Encoder.BUFFER_SIZE = N * 1024` before
     * constructing any Encoder.
     */
    static BUFFER_SIZE = 16 * 1024;
    sharedBuffer: Uint8Array;

    context: TypeContext;
    state: T;
    root: Root;

    /** Per-pass stamps written into `ChangeTree._fullSyncGen`. */
    private _gen = 0;

    // per-tick filtered pass (encodeView): trees with filtered dirty state + chunk cache
    private _tickPrepared = false;
    private _filteredDirty: ChangeTree[] = [];
    private _cacheable: boolean[] = [];
    /**
     * Cross-view chunk cache: per tree (index into `_filteredDirty`) a chain
     * of entries, one per tag key encoded this tick — views that hold
     * different custom tags on the same tree produce different chunks, and
     * each must be replayable by the next view with that key. Chains live in
     * the flat `_cacheEntry*` arrays (allocation-free, reset per tick).
     */
    private _cacheHead: number[] = [];
    private _cacheEntryKey: number[] = [];
    private _cacheEntryStart: number[] = [];
    private _cacheEntryEnd: number[] = [];
    private _cacheEntryNext: number[] = [];
    private _cacheEntryLen = 0;
    private _scratch: Uint8Array = new Uint8Array(4096);
    private _scratchOffset = 0;
    /**
     * Per-view work lists, keyed by `view.id`: indexes into `_filteredDirty`
     * of the trees whose visibility bit that view holds. Built once per tick
     * in `_prepareTick` by fanning each dirty tree out over its bitmap, so a
     * view's pass costs O(its visible dirty trees) instead of
     * O(all filtered dirty trees) — the difference between 9 % and 100 % of
     * the world for an area-of-interest room with hundreds of clients.
     */
    private _viewDirty: number[][] = [];
    /**
     * Trees that inherit visibility from a parent and have no bit of their
     * own yet (`isVisibilitySharedWithParent`, memoized by
     * `isChangeTreeVisible` on first check). Every view checks these.
     */
    private _sharedVisDirty: number[] = [];
    /** Scratch: the current view's filtered work list (indexes into `_filteredDirty`). */
    private _viewSeq: number[] = [];
    /**
     * Live lengths of the scratch arrays above. They are never truncated with
     * `length = 0`: V8 drops the backing store on that and every push then
     * regrows it — one allocation chain per view per tick (stateview/tags
     * doubled its minor GCs before this).
     */
    private _filteredDirtyLen = 0;
    private _viewDirtyLen: number[] = [];
    private _sharedVisLen = 0;

    /**
     * @param bufferSize size of this encoder's shared output buffer
     * (default `Encoder.BUFFER_SIZE`). Throwaway encoders — the reflection
     * handshake — pass a small size and provide their own buffer, so a room
     * configured with a large `BUFFER_SIZE` does not allocate (and collect)
     * that much per client join.
     */
    constructor(state: T, root?: Root, bufferSize: number = Encoder.BUFFER_SIZE) {
        this.sharedBuffer = new Uint8Array(bufferSize);
        //
        // Use .cache() here to avoid re-creating a new context for every new room instance.
        //
        this.context = TypeContext.cache(state.constructor as typeof Schema);
        this.root = root ?? new Root(this.context);
        this.setState(state);
    }

    protected setState(state: T) {
        this.state = state;
        refTreeOf(this.state).setRoot(this.root);
    }

    private _beginPass(buffer: Uint8Array, it: Iterator, view: StateView | undefined, emitFiltered: boolean, mode: number): Frame {
        // Settle any pending per-edge filter re-derivations before routing
        // fields to channels (see inheritedFlags.drainFilterRefresh).
        if (this.root.pendingFilterRefresh.length > 0) drainFilterRefresh(this.root);
        const f = passFrame();
        f.context = this.context;
        f.buffer = buffer;
        f.it = it;
        f.capacity = buffer.byteLength;
        f.view = view;
        f.hasView = view !== undefined;
        f.emitFiltered = emitFiltered;
        f.mode = mode;
        f.genA = ++this._gen;
        f.genB = ++this._gen;
        f.prevRefId = -1; // first chunk of this slice carries an absolute refId
        return f;
    }

    // ── snapshot ────────────────────────────────────────────────────────

    encodeAll(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_SNAPSHOT);
        const rootTree = refTreeOf(this.state);
        rootTree._fullSyncGen = f.genB;
        enterFrame(f, rootTree);
        emitLiveChunk(f, forEachLiveWithCtx);
        closeChunk(f);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encodeAll(it, buffer);
        }
        // `Reflection.encode` builds a throwaway encoder that never discards:
        // drop the frame pool's tree references here as well.
        releaseFrames();
        return buffer.subarray(initialOffset, it.offset);
    }

    /** View region of a full sync: filtered fields / trees visible to `view`. */
    encodeAllView(view: StateView, sharedOffset: number, it: Iterator, buffer: Uint8Array = this.sharedBuffer): [Uint8Array, Uint8Array] {
        const viewOffset = it.offset;
        const f = this._beginPass(buffer, it, view, true, MODE_SNAPSHOT);
        walkView(f, refTreeOf(this.state));

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = viewOffset;
            return this.encodeAllView(view, sharedOffset, it, buffer);
        }
        releaseFrames();
        return [buffer.subarray(0, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    // ── patch ───────────────────────────────────────────────────────────

    /** Shared (unfiltered) per-tick patch. */
    encode(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_PATCH);
        encodeQueue(f, this.root.changes);

        // Broadcast-mode stream emission runs after the main loop (state /
        // parent refs are already on the wire). Skipped when any StateView
        // is registered (the priority pass in `encodeView` owns emission).
        if (this.root.activeViews.size === 0 && this.root.streamTrees.size > 0) {
            this._emitStreamBroadcast(f);
        }

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encode(it, buffer);
        }
        return buffer.subarray(initialOffset, it.offset);
    }

    /**
     * Per-view patch: the stream priority pass, the `view.changes` drain
     * (visibility bootstrap, with inline bodies for newly-visible subtrees)
     * and the tick's filtered ops visible to this view. Returns the shared
     * slice and the view slice.
     */
    encodeView(view: StateView, sharedOffset: number, it: Iterator, buffer: Uint8Array = this.sharedBuffer): [Uint8Array, Uint8Array] {
        // Runs once, BEFORE the (overflow-recursive) body: it moves stream
        // positions from pending to sent, which must not happen twice.
        this._emitStreamPriority(view);
        return this._encodeViewBody(view, sharedOffset, it, buffer);
    }

    private _encodeViewBody(view: StateView, sharedOffset: number, it: Iterator, buffer: Uint8Array): [Uint8Array, Uint8Array] {
        const viewOffset = it.offset;

        // Idle view: nothing queued for it and none of its visible trees are
        // dirty. Skip the pass setup and the per-view slice allocation — with
        // hundreds of clients most views are idle on most ticks.
        if (view.changes.size === 0) {
            if (!this._tickPrepared) this._prepareTick();
            const ownLen = this._viewDirtyLen[view.id];
            if ((ownLen === undefined || ownLen === 0) && this._sharedVisLen === 0) {
                return [this._sharedSlice(buffer, sharedOffset), EMPTY_SLICE];
            }
        }

        const f = this._beginPass(buffer, it, view, true, MODE_DRAIN);
        const root = this.root;

        // 1. view.changes drain — Map insertion order is topological
        for (const [refId, entry] of view.changes) {
            const tree: ChangeTree | undefined = root.changeTrees.get(refId);
            if (tree === undefined) {
                view.changes.delete(refId); // detached instance
                continue;
            }
            if (entry.size === 0) continue;
            const stamp = tree._fullSyncGen;
            if (stamp === f.genA || stamp === f.genB) continue; // inlined already
            enterFrame(f, tree);
            emitViewEntry(f, entry);
            closeChunk(f);
        }

        // 2. per-tick filtered ops for this view (runs, the cross-view chunk
        //    cache); its own method keeps both functions small enough for
        //    TurboFan to optimize well
        f.mode = MODE_PATCH;
        if (!this._tickPrepared) this._prepareTick();
        this._emitViewTrees(f, view, buffer, it);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = viewOffset;
            return this._encodeViewBody(view, sharedOffset, it, buffer);
        }

        view.changes.clear();
        return [this._sharedSlice(buffer, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    /**
     * Phase 2 of a view pass: this view's dirty filtered trees — same-shape
     * runs, the cross-view chunk cache, plain chunks. Separate from
     * `_encodeViewBody` on purpose: one big function regressed every
     * active-view unit by 3–13 % each time it grew (bench/realworld-results.md).
     */
    private _emitViewTrees(f: Frame, view: StateView, buffer: Uint8Array, it: Iterator): void {
        const root = this.root;
        const useCache = root.activeViews.size > 1;
        const trees = this._filteredDirty;
        // This view's work list: its own list merged with the shared-visibility
        // list (both ascending; a memoized tree can sit in both — emit once),
        // filtered down to visible, not-yet-emitted trees. Materialized so the
        // run detection below can look ahead.
        const seq = this._viewSeq;
        let seqLen = 0;
        {
            const own = this._viewDirty[view.id];
            const shared = this._sharedVisDirty;
            const ownLen = (own === undefined) ? 0 : this._viewDirtyLen[view.id];
            const sharedLen = this._sharedVisLen;
            if (sharedLen === 0) {
                for (let a = 0; a < ownLen; a++) {
                    const i = own![a];
                    const tree = trees[i];
                    if (tree._fullSyncGen !== f.genB && view.isChangeTreeVisible(tree)) seq[seqLen++] = i;
                }
            } else {
                let a = 0, b = 0;
                while (a < ownLen || b < sharedLen) {
                    const ia = (a < ownLen) ? own![a] : 0x7fffffff;
                    const ib = (b < sharedLen) ? shared[b] : 0x7fffffff;
                    let i: number;
                    if (ia <= ib) { i = ia; a++; if (ia === ib) b++; }
                    else { i = ib; b++; }
                    const tree = trees[i];
                    if (tree._fullSyncGen !== f.genB && view.isChangeTreeVisible(tree)) seq[seqLen++] = i;
                }
            }
        }

        for (let s = 0; s < seqLen; s++) {
            const i = seq[s];
            const tree = trees[i];

            // same-shape run over consecutive visible filtered trees of one class
            // (cheap peek at the next tree first; typeId lookup only for a real run)
            const peek = (s + 1 < seqLen) ? trees[seq[s + 1]] : undefined;
            if (peek !== undefined && peek.encDescriptor === tree.encDescriptor && peek.dirtyLow === tree.dirtyLow && tree.isFiltered && runEligible(tree, true)) {
                let n = 0;
                while (s + 1 + n < seqLen) {
                    const next = trees[seq[s + 1 + n]];
                    if (!next.isFiltered || !runContinues(tree, next, true)) break;
                    n++;
                }
                if (n > 0 && f.context.getTypeId(tree.ref.constructor) !== undefined) {
                    if (tree.isNew) tree._fullSyncGen = f.genB;
                    enterFrame(f, tree);
                    openRun(f, tree, n);
                    for (let k = 1; k <= n; k++) {
                        const member = trees[seq[s + k]];
                        if (member.isNew) member._fullSyncGen = f.genB;
                        addRunMember(f, member);
                    }
                    endRun(f);
                    s += n;
                    continue;
                }
            }

            const cacheable = useCache && this._cacheable[i];
            let key = -1;
            if (cacheable) {
                key = tagKey(view, tree);
                let e = this._cacheHead[i];
                while (e !== -1 && this._cacheEntryKey[e] !== key) e = this._cacheEntryNext[e];
                if (e !== -1) {
                    // cached = length byte(s) + body; the refId header is a
                    // delta against THIS view's previous chunk, so it is
                    // rewritten per view
                    const start = this._cacheEntryStart[e];
                    const len = this._cacheEntryEnd[e] - start;
                    if (len > 0) {
                        writeChunkHeader(f, tree.refId);
                        if (it.offset + len <= buffer.byteLength) {
                            copyBytes(this._scratch, start, buffer, it.offset, len);
                        }
                        it.offset += len;
                    }
                    continue;
                }
            }

            if (tree.isNew) tree._fullSyncGen = f.genB;
            enterFrame(f, tree);
            encodeTreeOps(f);
            const lenPos = f.lenPos; // -1 when nothing passed the gate (no chunk opened)
            closeChunk(f);

            if (cacheable && it.offset <= buffer.byteLength) {
                this._cacheChunk(i, key, buffer, (lenPos === -1) ? it.offset : lenPos, it.offset);
            }
        }
    }

    /** The tick's shared slice, one Uint8Array view reused by every client (read-only for the transport). */
    private _sharedSlice(buffer: Uint8Array, sharedOffset: number): Uint8Array {
        let slice = this._sharedSliceCache;
        if (slice === undefined || slice.buffer !== buffer.buffer || slice.byteOffset !== buffer.byteOffset || slice.byteLength !== sharedOffset) {
            slice = this._sharedSliceCache = buffer.subarray(0, sharedOffset);
        }
        return slice;
    }
    private _sharedSliceCache: Uint8Array | undefined = undefined;

    /** Collect the tick's trees with filtered dirty state, once per tick. */
    private _prepareTick(): void {
        const trees = this._filteredDirty;
        const cacheable = this._cacheable;
        const cacheHead = this._cacheHead;
        const prevLen = this._filteredDirtyLen;
        let n = 0;
        this._scratchOffset = 0;
        this._cacheEntryLen = 0;
        const viewDirty = this._viewDirty;
        const viewDirtyLen = this._viewDirtyLen;
        for (let k = 0; k < viewDirtyLen.length; k++) viewDirtyLen[k] = 0;
        const sharedVis = this._sharedVisDirty;
        let sharedVisLen = 0;

        let current: ChangeTreeList | ChangeTreeNode = this.root.changes;
        while (current = current.next) {
            const tree = (current as ChangeTreeNode).changeTree;
            if (!tree.has()) continue;
            const desc = tree.encDescriptor;
            let include = tree.isFiltered;
            let canCache = false;
            if (!include && tree._isSchema && desc.hasAnyView) {
                include = (tree.dirtyLow & desc.filterBitmask) !== 0
                    || (tree.dirtyHigh !== 0 && desc.hasTagAbove32);
            }
            if (!include) continue;
            if (tree._isSchema) {
                // pure-primitive chunk → a function of (tree, view's custom tags); safe to memcpy
                canCache = (tree.dirtyLow & desc.refTypeBitmask) === 0 && (tree.dirtyHigh === 0 || !desc.hasRefFieldAbove32);
            } else {
                // primitive-child collections carry no per-element visibility
                canCache = typeof (tree.refTarget as any)[$childType] === "string";
            }
            const i = n++;
            trees[i] = tree;
            cacheable[i] = canCache;
            cacheHead[i] = -1;

            // fan out to the views that hold this tree's visibility bit
            const vv = tree.visibleViews;
            if (vv !== undefined) {
                for (let s = 0; s < vv.length; s++) {
                    let w = vv[s] | 0; // a hole reads as undefined
                    while (w !== 0) {
                        const bit = w & -w;
                        w ^= bit;
                        const id = (s << 5) + (31 - Math.clz32(bit));
                        let list = viewDirty[id];
                        if (list === undefined) { list = viewDirty[id] = []; viewDirtyLen[id] = 0; }
                        list[viewDirtyLen[id]++] = i;
                    }
                }
            }
            if (tree.isVisibilitySharedWithParent) sharedVis[sharedVisLen++] = i;
        }
        // drop stale tree references past this tick's count (no truncation: keeps the backing store)
        for (let k = n; k < prevLen; k++) trees[k] = undefined!;
        this._filteredDirtyLen = n;
        this._sharedVisLen = sharedVisLen;
        this._tickPrepared = true;
    }

    private _cacheChunk(i: number, key: number, buffer: Uint8Array, start: number, end: number): void {
        const len = end - start;
        if (this._scratchOffset + len > this._scratch.byteLength) {
            const grown = new Uint8Array(Math.max(this._scratch.byteLength * 2, this._scratchOffset + len));
            grown.set(this._scratch.subarray(0, this._scratchOffset));
            this._scratch = grown;
        }
        copyBytes(buffer, start, this._scratch, this._scratchOffset, len);
        // prepend to the tree's chain
        const e = this._cacheEntryLen++;
        this._cacheEntryKey[e] = key;
        this._cacheEntryStart[e] = this._scratchOffset;
        this._cacheEntryEnd[e] = this._scratchOffset + len;
        this._cacheEntryNext[e] = this._cacheHead[i];
        this._cacheHead[i] = e;
        this._scratchOffset += len;
    }

    // ── unreliable channel ──────────────────────────────────────────────

    /**
     * Per-tick encode of the UNRELIABLE channel. Walks `root.unreliableChanges`
     * and emits each tree's `unreliableRecorder`. Safe to call at a different
     * cadence than `encode()` (e.g. 60Hz vs 20Hz) — the two channels are
     * fully independent.
     */
    encodeUnreliable(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_PATCH);
        this._encodeUnreliableQueue(f);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encodeUnreliable(it, buffer);
        }
        return buffer.subarray(initialOffset, it.offset);
    }

    /**
     * Per-view unreliable encode: only filtered `@unreliable` fields visible
     * to this view. No `view.changes` drain — those belong to the reliable
     * channel's bootstrap.
     */
    encodeUnreliableView(view: StateView, sharedOffset: number, it: Iterator, buffer: Uint8Array = this.sharedBuffer): [Uint8Array, Uint8Array] {
        const viewOffset = it.offset;
        const f = this._beginPass(buffer, it, view, true, MODE_PATCH);
        this._encodeUnreliableQueue(f);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = viewOffset;
            return this.encodeUnreliableView(view, sharedOffset, it, buffer);
        }
        return [buffer.subarray(0, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    private _encodeUnreliableQueue(f: Frame): void {
        let current: ChangeTreeList | ChangeTreeNode = this.root.unreliableChanges;
        while (current = current.next) {
            const tree = (current as ChangeTreeNode).changeTree;
            const rec = tree.unreliableRecorder as SchemaChangeRecorder | undefined;
            if (rec === undefined || !rec.has()) continue;
            if (f.hasView && !f.view!.isChangeTreeVisible(tree)) continue;
            enterFrame(f, tree);
            encodeSchemaBits(f, rec.dirtyLow, rec.dirtyHigh, rec.ops);
            closeChunk(f);
        }
    }

    // ── streams ─────────────────────────────────────────────────────────

    /**
     * Broadcast-mode counterpart to `_emitStreamPriority`. Runs when NO
     * StateViews are registered — streams fall back to broadcast mode
     * where up to `maxPerTick` pending ADDs per stream emit to ALL clients
     * each shared tick. DELETEs always flush (no cap).
     *
     * Emits into the shared patch: stream & element trees are
     * `isFiltered=true` so the main loop skipped them. Each added element
     * rides inline as a live body; already-sent elements emit their dirty
     * fields as their own chunk. `@unreliable` fields stay out (MODE_STREAM).
     */
    private _emitStreamBroadcast(f: Frame): void {
        f.emitFiltered = true;
        f.mode = MODE_STREAM;
        for (const stream of this.root.streamTrees) {
            const s: any = stream;
            const tree: ChangeTree = refTreeOf(s);
            if (tree.refId === undefined) continue; // never attached to the state
            const st = s._stream!;
            const deletes: Set<number> = st.broadcastDeletes;
            const pending: Set<number> = st.broadcastPending;
            const sent: Set<number> = st.sentBroadcast;

            if (deletes.size > 0 || pending.size > 0) {
                enterFrame(f, tree);
                openChunk(f);

                for (const pos of deletes) emitKeyedOp(f, pos, OPERATION.DELETE);
                deletes.clear();

                const max: number = st.maxPerTick;
                let count = 0;
                const toDelete: number[] = [];
                for (const pos of pending) {
                    if (count >= max) break;
                    if (s[$getByIndex](pos) === undefined) {
                        toDelete.push(pos);
                        continue;
                    }
                    emitKeyedOp(f, pos, OPERATION.ADD); // element body inline (MODE_STREAM)
                    sent.add(pos);
                    toDelete.push(pos);
                    count++;
                }
                for (const pos of toDelete) pending.delete(pos);
                closeChunk(f);
            }

            // Mutation updates for already-sent elements: their trees are
            // filtered, so the main loop skipped them.
            for (const pos of sent) {
                const element = s[$getByIndex](pos);
                if (element === undefined) continue;
                const elTree: ChangeTree | undefined = refTreeOf(element);
                if (elTree === undefined || !elTree.has() || elTree._fullSyncGen === f.genB) continue;
                if (elTree.refId === undefined) continue;
                enterFrame(f, elTree);
                encodeSchemaOps(f);
                closeChunk(f);
            }
        }
        f.emitFiltered = false;
        f.mode = MODE_PATCH;
    }

    /**
     * Walk every registered stream, pick up to `maxPerTick` positions from
     * this view's pending backlog (priority-sorted when the view supplies a
     * priority callback), and hand each element to `view.add()`.
     * `view.add()` seeds `view.changes` so the subsequent drain emits both
     * the stream-link (position → refId) and the element's field data.
     *
     * Runs at the very top of `encodeView`, BEFORE the drain loop.
     */
    private _emitStreamPriority(view: StateView): void {
        const streams = this.root.streamTrees;
        if (streams.size === 0) return;

        const viewId = view.id;

        for (const stream of streams) {
            const s: any = stream;
            const st = s._stream!;
            const pending: Set<number> | undefined = st.pendingByView.get(viewId);
            if (pending === undefined || pending.size === 0) continue;

            // A per-view callback (registered by `subscribe(coll, fn)`) wins
            // over the declaration-scope one.
            const perView = st.priorityByView?.get(viewId);
            const usePerView = perView !== undefined;
            const priority = st.priority;
            const max = st.maxPerTick;

            // Select the `max` highest-priority candidates with a bounded
            // top-`max` window (n callback invocations, no sort).
            const positions: number[] = [];
            const stale: number[] = [];

            if (usePerView || priority !== undefined) {
                const bestPos: number[] = [];
                const bestScore: number[] = [];
                let filled = 0;

                for (const pos of pending) {
                    const element = s[$getByIndex](pos);
                    if (element === undefined) {
                        stale.push(pos);
                        continue;
                    }

                    const score = usePerView
                        ? perView!(element)
                        : priority!(view, element);

                    if (filled < max) {
                        let j = filled++;
                        while (j > 0 && bestScore[j - 1] < score) {
                            bestScore[j] = bestScore[j - 1];
                            bestPos[j] = bestPos[j - 1];
                            j--;
                        }
                        bestScore[j] = score;
                        bestPos[j] = pos;

                    } else if (score > bestScore[max - 1]) {
                        let j = max - 1;
                        while (j > 0 && bestScore[j - 1] < score) {
                            bestScore[j] = bestScore[j - 1];
                            bestPos[j] = bestPos[j - 1];
                            j--;
                        }
                        bestScore[j] = score;
                        bestPos[j] = pos;
                    }
                }

                for (let i = 0; i < filled; i++) positions.push(bestPos[i]);

            } else {
                // FIFO — take the head of the backlog, no scoring needed.
                for (const pos of pending) {
                    if (positions.length >= max) break;
                    positions.push(pos);
                }
            }

            for (const pos of stale) pending.delete(pos);

            let sent: Set<number> | undefined = st.sentByView.get(viewId);
            if (sent === undefined) {
                sent = new Set();
                st.sentByView.set(viewId, sent);
            }

            for (let i = 0, count = positions.length; i < count; i++) {
                const pos = positions[i];
                const element = s[$getByIndex](pos);
                if (element === undefined) {
                    pending.delete(pos);
                    continue;
                }
                // `_addImmediate` force-ships the element through view.changes
                // without routing it back into pending.
                view._addImmediate(element);
                // Force-seed element fields even when view.add skipped the
                // live walk (isNew && !isChildAdded). `@unreliable` fields are
                // excluded — they ship on the unreliable channel.
                const elTree = refTreeOf(element);
                if (elTree !== undefined) {
                    const elRefId = elTree.refId;
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

    // ── lifecycle ───────────────────────────────────────────────────────

    discardChanges(): void {
        discardQueue(this.root, this.root.changes);
        this._tickPrepared = false;
        releaseFrames(); // here, not per pass: a call in `encode()` costs inlining budget on the hot chain
    }

    discardUnreliableChanges(): void {
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

    get hasChanges(): boolean {
        return this.root.changes.next !== undefined;
    }

    get hasUnreliableChanges(): boolean {
        return this.root.unreliableChanges.next !== undefined;
    }

    /** Join the `[shared, view]` pair into one buffer (tests / single-buffer transports). */
    static concat(parts: Uint8Array[]): Uint8Array {
        let total = 0;
        for (const p of parts) total += p.byteLength;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
        return out;
    }

    private _resizeBuffer(buffer: Uint8Array, usedOffset: number): Uint8Array {
        return growSharedBuffer(this, buffer, usedOffset);
    }
}

/**
 * Shared patch loop: one chunk per dirty tree, skipping trees inlined earlier
 * in the pass. Reads flag bits and recorder state directly so the whole
 * per-tree + per-field path fits V8's cumulative inlining budget (no call
 * per tree).
 */
function encodeQueue(f: Frame, queue: ChangeTreeList): void {
    let current: ChangeTreeList | ChangeTreeNode = queue;
    while (current = current.next) {
        const tree = (current as ChangeTreeNode).changeTree;
        if (tree._fullSyncGen === f.genB) continue;
        const flags = tree.flags;
        if ((flags & IS_FILTERED) !== 0) continue; // every op of a filtered tree belongs to the view pass
        const isSchema = tree._isSchema;
        if (isSchema ? (tree.dirtyLow | tree.dirtyHigh) === 0 : !tree.has()) continue;
        // only a fresh tree can be inlined by a later parent op → only those need the "emitted" stamp
        if ((flags & IS_NEW) !== 0) tree._fullSyncGen = f.genB;
        enterFrame(f, tree);
        if (isSchema) {
            // same-shape run: look ahead for consecutive trees of this class with
            // the same dirty primitives. Cheap peek first (interleaved classes and
            // single-chunk ticks must not pay the eligibility loop), the handshake
            // typeId lookup only once a run actually forms.
            let node: ChangeTreeNode | undefined = (current as ChangeTreeNode).next;
            if (node !== undefined && node.changeTree.encDescriptor === tree.encDescriptor && node.changeTree.dirtyLow === tree.dirtyLow && runEligible(tree, false)) {
                let n = 0;
                while (node !== undefined && node.changeTree._fullSyncGen !== f.genB && (node.changeTree.flags & IS_FILTERED) === 0 && runContinues(tree, node.changeTree, false)) {
                    n++;
                    node = node.next;
                }
                if (n > 0 && f.context.getTypeId(tree.ref.constructor) !== undefined) {
                    openRun(f, tree, n);
                    for (let k = 0; k < n; k++) {
                        current = (current as ChangeTreeNode).next!;
                        const member = (current as ChangeTreeNode).changeTree;
                        if ((member.flags & IS_NEW) !== 0) member._fullSyncGen = f.genB;
                        addRunMember(f, member);
                    }
                    endRun(f);
                    continue;
                }
            }
            encodeSchemaOps(f);
        }
        else if (tree.encDescriptor.kind === KIND_ARRAY) encodeTreeOps(f);
        else encodeKeyedOps(f);
        closeChunk(f);
    }
}

/**
 * Structural DFS for `encodeAllView`: visible trees emit their filtered-side
 * live fields as a chunk unless an inline body already carried them;
 * recursion continues either way so public trees with tagged fields deeper
 * down are reached.
 */
function walkView(f: Frame, tree: ChangeTree): void {
    const stamp = tree._fullSyncGen;
    if (stamp === f.genA) return;
    if (stamp !== f.genB && f.view!.isChangeTreeVisible(tree)) {
        enterFrame(f, tree);
        emitLiveChunk(f, forEachLiveWithCtx);
        closeChunk(f);
    }
    tree._fullSyncGen = f.genA;
    forEachChildWithCtx(tree, f, walkViewChildCb);
}

function walkViewChildCb(f: Frame, child: ChangeTree, _index: any): void {
    walkView(f, child);
}

/** Small chunks are copied byte by byte: `set(subarray())` allocates a view per call. */
function copyBytes(src: Uint8Array, from: number, dst: Uint8Array, to: number, len: number): void {
    if (len > 48) {
        dst.set(src.subarray(from, from + len), to);
    } else {
        for (let k = 0; k < len; k++) dst[to + k] = src[from + k];
    }
}

/** Cross-view chunk cache key: the custom tag bits `view` holds on `tree` that the tree's class declares. */
function tagKey(view: StateView, tree: ChangeTree): number {
    return view.tagsOnTree(tree) & tree.encDescriptor.customTagMask;
}
