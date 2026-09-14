import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $changes, $childType, $getByIndex, $refId } from "../types/symbols.js";
import type { Iterator } from "../encoding/decode.js";
import { KIND_ARRAY, OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { Root } from "./Root.js";
import type { StateView } from "./StateView.js";
import { IS_FILTERED, IS_NEW, type ChangeTree, type ChangeTreeList, type ChangeTreeNode } from "./ChangeTree.js";
import type { SchemaChangeRecorder } from "./ChangeRecorder.js";
import { forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import { forEachChildWithCtx } from "./changeTree/treeAttachment.js";
import { drainFilterRefresh } from "./changeTree/inheritedFlags.js";
import {
    MODE_DRAIN, MODE_PATCH, MODE_SNAPSHOT, MODE_STREAM,
    closeChunk, emitKeyedOp, emitLiveChunk, emitViewEntry, encodeKeyedOps, encodeSchemaBits, encodeSchemaOps, encodeTreeOps,
    enterFrame, openChunk, passFrame, releaseFrames, type Frame,
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
export class Encoder<T extends Schema = any> {
    /**
     * Per-encoder shared output buffer size. The encoder auto-grows on
     * overflow and logs a one-time warning suggesting a higher value, so
     * the default just needs to comfortably cover typical room state.
     * Raise per app via `Encoder.BUFFER_SIZE = N * 1024` before
     * constructing any Encoder.
     */
    static BUFFER_SIZE = 16 * 1024;
    sharedBuffer: Uint8Array = new Uint8Array(Encoder.BUFFER_SIZE);

    context: TypeContext;
    state: T;
    root: Root;

    /** Per-pass stamps written into `ChangeTree._fullSyncGen`. */
    private _gen = 0;

    // per-tick filtered pass (encodeView): trees with filtered dirty state + chunk cache
    private _tickPrepared = false;
    private _filteredDirty: ChangeTree[] = [];
    private _cacheable: boolean[] = [];
    private _cacheKey: number[] = [];
    private _cacheStart: number[] = [];
    private _cacheEnd: number[] = [];
    private _scratch: Uint8Array = new Uint8Array(4096);
    private _scratchOffset = 0;

    constructor(state: T, root?: Root) {
        //
        // Use .cache() here to avoid re-creating a new context for every new room instance.
        //
        this.context = TypeContext.cache(state.constructor as typeof Schema);
        this.root = root ?? new Root(this.context);
        this.setState(state);
    }

    protected setState(state: T) {
        this.state = state;
        this.state[$changes].setRoot(this.root);
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
        return f;
    }

    // ── snapshot ────────────────────────────────────────────────────────

    encodeAll(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_SNAPSHOT);
        const rootTree = this.state[$changes];
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
        walkView(f, this.state[$changes]);

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
        const f = this._beginPass(buffer, it, view, true, MODE_DRAIN);
        const root = this.root;

        // 1. view.changes drain — Map insertion order is topological
        for (const [refId, entry] of view.changes) {
            const tree: ChangeTree | undefined = root.changeTrees[refId];
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

        // 2. per-tick filtered ops (chunk cache across views — only worth it
        //    when a second view can reuse the copy)
        f.mode = MODE_PATCH;
        if (!this._tickPrepared) this._prepareTick();
        const useCache = root.activeViews.size > 1;
        const trees = this._filteredDirty;
        for (let i = 0, len = trees.length; i < len; i++) {
            const tree = trees[i];
            if (tree._fullSyncGen === f.genB) continue;
            if (!view.isChangeTreeVisible(tree)) continue;

            const cacheable = useCache && this._cacheable[i];
            let key = -1;
            if (cacheable) {
                key = tagKey(view, tree);
                if (this._cacheKey[i] === key) {
                    const start = this._cacheStart[i];
                    const len = this._cacheEnd[i] - start;
                    if (it.offset + len <= buffer.byteLength) {
                        copyBytes(this._scratch, start, buffer, it.offset, len);
                    }
                    it.offset += len;
                    continue;
                }
            }

            const start = it.offset;
            if (tree.isNew) tree._fullSyncGen = f.genB;
            enterFrame(f, tree);
            encodeTreeOps(f);
            closeChunk(f);

            if (cacheable && it.offset <= buffer.byteLength) {
                this._cacheChunk(i, key, buffer, start, it.offset);
            }
        }

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = viewOffset;
            return this._encodeViewBody(view, sharedOffset, it, buffer);
        }

        view.changes.clear();
        return [buffer.subarray(0, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    /** Collect the tick's trees with filtered dirty state, once per tick. */
    private _prepareTick(): void {
        const trees = this._filteredDirty;
        const cacheable = this._cacheable;
        trees.length = 0;
        cacheable.length = 0;
        this._cacheKey.length = 0;
        this._scratchOffset = 0;

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
            trees.push(tree);
            cacheable.push(canCache);
            this._cacheKey.push(-1);
        }
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
        this._cacheKey[i] = key;
        this._cacheStart[i] = this._scratchOffset;
        this._cacheEnd[i] = this._scratchOffset + len;
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
            const tree: ChangeTree = s[$changes];
            if (s[$refId] === undefined) continue; // never attached to the state
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
                const elTree: ChangeTree | undefined = element[$changes];
                if (elTree === undefined || !elTree.has() || elTree._fullSyncGen === f.genB) continue;
                if (element[$refId] === undefined) continue;
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
        if (isSchema) encodeSchemaOps(f);
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

function tagKey(view: StateView, tree: ChangeTree): number {
    const bits = tree.encDescriptor.customTagBits;
    let key = 0;
    for (let i = 0; i < bits.length; i++) {
        if (view.hasTagOnTree(tree, bits[i])) key |= bits[i];
    }
    return key;
}
