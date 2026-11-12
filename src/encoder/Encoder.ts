import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $childType, $getByIndex } from "../types/symbols.js";
import type { Iterator } from "../encoding/decode.js";
import { KIND_ARRAY, KIND_MAP, OPERATION, PROTOCOL_VERSION } from "../encoding/spec.js";
import { Reflection, populateReflection } from "../Reflection.js";
import { Metadata } from "../Metadata.js";
import { Root, type Streamable } from "./Root.js";
import type { StateView } from "./StateView.js";
import { IS_FILTERED, IS_NEW, type ChangeTree, type ChangeTreeList, type ChangeTreeNode, refTreeOf } from "./ChangeTree.js";
import type { SchemaChangeRecorder } from "./ChangeRecorder.js";
import { type KeyedRecorder, keyedValueAt } from "./KeyedRecorder.js";
import { forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import { ensureTracked, forEachChildWithCtx } from "./changeTree/treeAttachment.js";
import { drainFilterRefresh } from "./changeTree/inheritedFlags.js";
import { recordBroadcastSent, sentByBroadcast, streamHasBroadcastBacklog, streamHasViewBacklog } from "./streaming.js";
import {
    MODE_DRAIN, MODE_PATCH, MODE_SNAPSHOT, MODE_STREAM,
    closeChunk, emitKeyedOp, emitLiveChunk, emitViewEntry, encodeKeyedOps, encodeKeyedOpsAt, encodeSchemaBits, encodeSchemaOps, encodeTreeOps,
    enterFrame, openChunk, passFrame, releaseFrames, writeChunkHeader, type Frame,
    runEligible, runContinues, openRun, addRunMember, endRun,
} from "./EncodeOperation.js";

/** Largest size the overflow warning suggested, and the `BUFFER_SIZE` it was for. */
let warnedSize = 0;
let warnedFor = 0;

/** An encoder's first buffer: most rooms never need the whole `BUFFER_SIZE`, and a server may hold thousands of them. */
const INITIAL_BUFFER_SIZE = 1024;

/**
 * Grow an encoder's output buffer to 1.5× the `usedOffset` bytes the
 * overflowed pass measured (it keeps counting past the end, so one grow
 * fits). The headroom matters: every grow re-encodes the pass, and a state
 * that keeps growing would otherwise pay that at each step. Up to
 * `BUFFER_SIZE` the buffer grows quietly; past it, in `BUFFER_SIZE` steps,
 * warning only when a larger size than already suggested is needed.
 */
function growSharedBuffer(owner: { sharedBuffer: Uint8Array }, buffer: Uint8Array, usedOffset: number): Uint8Array {
    const configured = Encoder.BUFFER_SIZE;
    let newSize: number;
    if (usedOffset <= configured) {
        newSize = Math.min(configured, Math.max(buffer.byteLength * 2, Math.ceil(usedOffset * 1.5 / 1024) * 1024));
    } else {
        newSize = Math.ceil(usedOffset * 1.5 / configured) * configured;
        if (newSize > warnedSize || warnedFor !== configured) {
            warnedSize = newSize;
            warnedFor = configured;
            console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);
        }
    }

    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(buffer);

    if (buffer === owner.sharedBuffer) {
        owner.sharedBuffer = newBuffer;
    }

    return newBuffer;
}

/**
 * OR into `out` every view bit `StateView.isChangeTreeVisible` could grant
 * `tree`: its own, its primary parent's and filtered extra parents' — and,
 * through ancestors that share visibility too, theirs, since a view pass can
 * memoize those bits before it reaches `tree`. `visited` guards cyclic
 * instance graphs.
 */
function orGrantableViews(tree: ChangeTree, out: number[], visited: ChangeTree[]): void {
    const vv = tree.visibleViews;
    if (vv !== undefined) {
        for (let s = 0; s < vv.length; s++) out[s] = (out[s] | 0) | (vv[s] | 0); // holes read as undefined
    }
    if (!tree.isVisibilitySharedWithParent || visited.indexOf(tree) !== -1) return;
    visited.push(tree);
    const parent = tree.parentTree;
    if (parent !== undefined) orGrantableViews(parent, out, visited);
    for (let e = tree.aux?.extraParents; e !== undefined; e = e.next) {
        if (e.tree.isFiltered) orGrantableViews(e.tree, out, visited);
    }
}

/** `orGrantableViews` into the zeroed scratch `out`, which it returns. */
function grantableViews(tree: ChangeTree, out: number[], visited: ChangeTree[]): number[] {
    for (let s = 0; s < out.length; s++) out[s] = 0;
    orGrantableViews(tree, out, visited);
    while (visited.length !== 0) visited.pop();
    return out;
}

/**
 * The first entry `tree` touched this tick shares the collection's
 * visibility (an untagged or `@view(N)` collection): every viewer then sees
 * every op, and routing them would only duplicate the fan-out.
 */
function entriesShareVisibility(tree: ChangeTree, rec: KeyedRecorder): boolean {
    for (let k = 0, n = rec.count; k < n; k++) {
        const child = refTreeOf(keyedValueAt(tree.ref, rec, rec.order[k]));
        if (child !== undefined) return child.isVisibilitySharedWithParent;
    }
    return false;
}

/** End the tick for every tree in `list`: reset recorders, release queue nodes. */
function discardQueue(root: Root, list: ChangeTreeList): void {
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

// One buffer for every reflection handshake in the process (the payload is
// copied out): a room with a large `Encoder.BUFFER_SIZE` must not allocate
// that much per client join. `encodeAll` grows it if a schema's reflection is
// larger, and the grown buffer is kept.
let reflectionBuffer: Uint8Array | undefined;

export class Encoder<T extends Schema = any> {
    /**
     * Size a shared output buffer may reach without a warning. Buffers
     * start small and grow on overflow; past this size the encoder still
     * grows, and warns with a higher value to set (again only when a
     * later overflow needs more), so the default just needs to
     * comfortably cover typical room state.
     * Raise per app via `Encoder.BUFFER_SIZE = N * 1024` before
     * constructing any Encoder.
     */
    static BUFFER_SIZE = 16384; // a literal (16 KB): esbuild keeps the class over `16 * 1024`
    sharedBuffer: Uint8Array;

    context: TypeContext;
    state: T;
    root: Root;

    /** Per-pass stamps written into `ChangeTree._fullSyncGen`. */
    private _gen = 0;

    // per-tick filtered pass (encodeView): trees with filtered dirty state + chunk cache
    private _tickPrepared = false;
    private _filteredDirty: ChangeTree[] = [];
    /** Scratch for `encode()` in broadcast-stream mode: the dirty filtered trees `encodeQueue` skipped (its return value is the live length). */
    private _skippedFiltered: ChangeTree[] = [];
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
    private _scratch: Uint8Array = EMPTY_SLICE; // grows on first use: only rooms with several views cache chunks
    private _scratchOffset = 0;
    /**
     * Per-view work lists, keyed by `view.id`: indexes into `_filteredDirty`
     * of the trees whose visibility bit that view holds — or, for a tree
     * sharing its parent's visibility, could be granted it on first check
     * (`orGrantableViews`). Built once per tick in `_prepareTick` by fanning
     * each dirty tree out over its bitmap, so a view's pass costs O(its
     * visible dirty trees) instead of O(all filtered dirty trees). A
     * snapshot: bits set after it (a `view.add` between `encodeView` calls)
     * reach the client through `view.changes`, never through these lists.
     */
    private _viewDirty: number[][] = [];
    /**
     * Per-view routed keyed ops, keyed by `view.id`: `(tree index, entry)`
     * pairs in tree then record order, for the filtered keyed collections
     * marked in `_routedOps`. Each op goes only to the views that can see its
     * child (`_routeKeyedOps`), so a view walks its own ops, not the room's.
     */
    private _viewOps: number[][] = [];
    private _routedOps: boolean[] = [];
    /** Scratch for `_prepareTick`: one shared-visibility tree's grantable view bits, and its walk's visited set. */
    private _grantableViews: number[] = [];
    private _grantVisited: ChangeTree[] = [];
    /** Scratch: the current view's filtered work list (indexes into `_filteredDirty`). */
    private _viewSeq: number[] = [];
    /**
     * Live lengths of the scratch arrays above. They are never truncated with
     * `length = 0`: V8 drops the backing store on that and every push then
     * regrows it — one allocation chain per view per tick.
     */
    private _filteredDirtyLen = 0;
    private _viewDirtyLen: number[] = [];
    private _viewOpsLen: number[] = [];

    /**
     * @param bufferSize initial size of this encoder's shared output
     * buffer. It starts small and grows with what the state needs, so
     * `Encoder.BUFFER_SIZE` is paid only by the rooms that fill it.
     */
    constructor(state: T, root?: Root, bufferSize: number = Math.min(Encoder.BUFFER_SIZE, INITIAL_BUFFER_SIZE)) {
        this.sharedBuffer = new Uint8Array(bufferSize);
        // Use .cache() here to avoid re-creating a new context for every new room instance.
        this.context = TypeContext.cache(state.constructor as typeof Schema);
        this.root = root ?? new Root(this.context);
        this.setState(state);
    }

    protected setState(state: T) {
        this.state = state;
        const tree: any = ensureTracked(refTreeOf(state));
        if (tree.root === undefined && tree.refId !== undefined) {
            // an id this Root did not hand out (a decoded state's root): allocate our own
            tree.refId = undefined;
            tree.needsRestage = true;
            if (tree.decodeInfo !== undefined) tree.decodeInfo = undefined; // a later decode into it hits the relay guard
        }
        tree.setRoot(this.root);
    }

    /**
     * `Reflection.encode(encoder)`: `uvarint(PROTOCOL_VERSION)` followed by the
     * `Reflection` schema encoded with the codec itself (nested Schema + array
     * + optional field — a self-hosting fixture).
     *
     * Named by `$encodeReflection`'s value: esbuild keeps an unused class with
     * a computed key that isn't a literal.
     */
    "~encodeReflection"(): Uint8Array {
        const reflection = new Reflection();
        const reflectionEncoder = new Encoder(reflection, undefined, 0);
        reflectionEncoder.sharedBuffer = (reflectionBuffer ??= new Uint8Array(64 * 1024));
        populateReflection(reflection, this.context, this.state.constructor as typeof Schema);
        const encoded = reflectionEncoder.encodeAll();
        reflectionBuffer = reflectionEncoder.sharedBuffer;
        const out = new Uint8Array(1 + encoded.byteLength);
        out[0] = PROTOCOL_VERSION;
        out.set(encoded, 1);
        return out;
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
        return buffer.subarray(0, it.offset); // from 0: keeps a caller-written prefix (protocol byte)
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
        // The snapshot carries everything queued for a view nobody has seen
        // yet; draining it again would resend the whole view in the next patch.
        if (!view.encoded) {
            view.encoded = true;
            view.changes.clear();
        }
        return [buffer.subarray(0, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    // ── patch ───────────────────────────────────────────────────────────

    /** Shared (unfiltered) per-tick patch. */
    encode(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_PATCH);
        // Broadcast-mode stream emission runs after the main loop (state /
        // parent refs are already on the wire). Skipped when any StateView
        // is registered (the priority pass in `encodeView` owns emission).
        const broadcast = this.root.activeViews.size === 0 && this.root.streamTrees.size > 0;
        const skipped = encodeQueue(f, this.root.changes, broadcast ? this._skippedFiltered : undefined);
        if (broadcast) this._emitStreamBroadcast(f, skipped);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encode(it, buffer);
        }
        return buffer.subarray(0, it.offset); // from 0: keeps a caller-written prefix (protocol byte)
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
        view.encoded = true;

        // Idle view: nothing queued for it and none of its visible trees are
        // dirty. Skip the pass setup and the per-view slice allocation — with
        // hundreds of clients most views are idle on most ticks.
        if (view.changes.size === 0) {
            if (!this._tickPrepared) this._prepareTick();
            if ((this._viewDirtyLen[view.id] | 0) === 0) {
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
     * `_encodeViewBody` on purpose: one big function optimizes worse
     * (bench/realworld-results.md, x9).
     */
    private _emitViewTrees(f: Frame, view: StateView, buffer: Uint8Array, it: Iterator): void {
        const root = this.root;
        const useCache = root.activeViews.size > 1;
        const trees = this._filteredDirty;
        // This view's work list (ascending), filtered down to visible,
        // not-yet-emitted trees. Materialized so the run detection below can
        // look ahead.
        const seq = this._viewSeq;
        let seqLen = 0;
        const own = this._viewDirty[view.id];
        const ownLen = this._viewDirtyLen[view.id] | 0; // non-zero only where `own` exists
        for (let a = 0; a < ownLen; a++) {
            const i = own[a];
            const tree = trees[i];
            if (tree._fullSyncGen !== f.genB && view.isChangeTreeVisible(tree)) seq[seqLen++] = i;
        }
        const ops = this._viewOps[view.id];
        const opsLen = this._viewOpsLen[view.id] | 0;
        let opPos = 0;

        const slots = _slots;
        slots.open = 0;
        for (let s = 0; s < seqLen; s++) {
            const i = seq[s];
            const tree = trees[i];

            // same-shape run: cheap checks here (an open slot, or the shape
            // again within the next few trees), the rest out of line so this
            // function stays small enough to optimize well
            if (tree.dirtyLow !== 0 && (slots.open !== 0 || peekShapeSeq(trees, seq, s + 1, seqLen, tree.encDescriptor, tree.dirtyLow))) {
                const taken = viewRun(f, trees, seq, s, seqLen);
                if (taken >= 0) {
                    s += taken;
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
            if (this._routedOps[i]) {
                // this view's routed ops of tree i: skip pairs of trees it didn't emit
                while (opPos < opsLen && ops[opPos] < i) opPos += 2;
                let end = opPos;
                while (end < opsLen && ops[end] === i) end += 2;
                encodeKeyedOpsAt(f, ops, opPos, end);
                opPos = end;
            } else {
                encodeTreeOps(f);
            }
            const lenPos = f.lenPos; // -1 when nothing passed the gate (no chunk opened)
            closeChunk(f);

            if (cacheable && it.offset <= buffer.byteLength) {
                this._cacheChunk(i, key, buffer, (lenPos === -1) ? it.offset : lenPos, it.offset);
            }
        }
        if (slots.open !== 0) flushSlots(f);
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
        for (let k = 0; k < viewDirtyLen.length; k++) {
            trimWorkList(viewDirty[k], viewDirtyLen[k]);
            viewDirtyLen[k] = 0;
        }
        const viewOps = this._viewOps;
        const viewOpsLen = this._viewOpsLen;
        for (let k = 0; k < viewOpsLen.length; k++) {
            trimWorkList(viewOps[k], viewOpsLen[k]);
            viewOpsLen[k] = 0;
        }
        const routedOps = this._routedOps;
        const grantable = this._grantableViews;
        const visited = this._grantVisited;

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
            let routed = false;
            if (tree._isSchema) {
                // pure-primitive chunk → a function of (tree, view's custom tags); safe to memcpy
                canCache = (tree.dirtyLow & desc.refTypeBitmask) === 0 && (tree.dirtyHigh === 0 || !desc.hasRefFieldAbove32);
            } else {
                // primitive-child collections carry no per-element visibility
                canCache = typeof (tree.ref as any)[$childType] === "string";
                // not streams: `_emitStreamPriority` grants element visibility per view, after this snapshot
                routed = !canCache && desc.routable && !tree.isStreamCollection
                    && !entriesShareVisibility(tree, tree.rec as KeyedRecorder);
            }
            const i = n++;
            trees[i] = tree;
            cacheable[i] = canCache;
            cacheHead[i] = -1;
            routedOps[i] = routed;
            if (routed) {
                // only views with a routed op visit the tree — unless all must: a new tree's pass stamp, a CLEAR
                const onlyRouted = !tree.isNew && !(tree.rec as KeyedRecorder).cleared;
                this._routeKeyedOps(tree, i, onlyRouted);
                if (onlyRouted) continue;
            }

            // fan out to the views that hold this tree's visibility bit (or could be granted it; each view re-checks)
            const vv = tree.isVisibilitySharedWithParent ? grantableViews(tree, grantable, visited) : tree.visibleViews;
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
        }
        // drop stale tree references past this tick's count (no truncation: keeps the backing store)
        for (let k = n; k < prevLen; k++) trees[k] = undefined!;
        this._filteredDirtyLen = n;
        this._tickPrepared = true;
    }

    /**
     * Route each op of keyed collection `i` to the views that can see its
     * child, as `(i, entry)` pairs on `_viewOps`: `~index` when the child's
     * own bit decides (all the stock filter would re-read), `index` when a
     * shared child may be granted visibility mid-pass and must be filtered.
     * `addTree`: also list `i` for each view that gets an op.
     */
    private _routeKeyedOps(tree: ChangeTree, i: number, addTree: boolean): void {
        const rec = tree.rec as KeyedRecorder;
        const ref = tree.ref;
        const order = rec.order;
        const viewOps = this._viewOps;
        const viewOpsLen = this._viewOpsLen;
        const viewDirty = this._viewDirty;
        const viewDirtyLen = this._viewDirtyLen;
        for (let k = 0, count = rec.count; k < count; k++) {
            const index = order[k];
            const child = refTreeOf(keyedValueAt(ref, rec, index));
            if (child === undefined) continue; // no view's filter passes it
            const shared = child.isVisibilitySharedWithParent;
            const vv = shared ? grantableViews(child, this._grantableViews, this._grantVisited) : child.visibleViews;
            if (vv === undefined) continue;
            const entry = shared ? index : ~index;
            for (let s = 0; s < vv.length; s++) {
                let w = vv[s] | 0; // a hole reads as undefined
                while (w !== 0) {
                    const bit = w & -w;
                    w ^= bit;
                    const id = (s << 5) + (31 - Math.clz32(bit));
                    let list = viewOps[id];
                    if (list === undefined) { list = viewOps[id] = []; viewOpsLen[id] = 0; }
                    const at = viewOpsLen[id];
                    if (addTree && (at === 0 || list[at - 2] !== i)) {
                        let trees = viewDirty[id];
                        if (trees === undefined) { trees = viewDirty[id] = []; viewDirtyLen[id] = 0; }
                        trees[viewDirtyLen[id]++] = i;
                    }
                    list[at] = i;
                    list[at + 1] = entry;
                    viewOpsLen[id] = at + 2;
                }
            }
        }
    }

    private _cacheChunk(i: number, key: number, buffer: Uint8Array, start: number, end: number): void {
        const len = end - start;
        if (this._scratchOffset + len > this._scratch.byteLength) {
            const grown = new Uint8Array(Math.max(256, this._scratch.byteLength * 2, this._scratchOffset + len));
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
        return buffer.subarray(0, it.offset); // from 0: keeps a caller-written prefix (protocol byte)
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
    private _emitStreamBroadcast(f: Frame, dirtyFiltered: number): void {
        f.emitFiltered = true;
        f.mode = MODE_STREAM;
        const streams = this.root.streamTrees;
        for (const stream of streams) {
            const s: any = stream;
            const tree: ChangeTree = refTreeOf(s);
            if (tree.refId === undefined) continue; // never attached to the state
            const st = s._stream!;
            const deletes: Set<number> = st.broadcastDeletes;
            const pending: Set<number> = st.broadcastPending;

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
                    const element = s[$getByIndex](pos);
                    if (element === undefined) {
                        toDelete.push(pos);
                        continue;
                    }
                    emitKeyedOp(f, pos, OPERATION.ADD); // element body inline (MODE_STREAM)
                    recordBroadcastSent(s, element, pos);
                    toDelete.push(pos);
                    count++;
                }
                for (const pos of toDelete) pending.delete(pos);
                closeChunk(f);
            }
        }

        // Mutation updates for already-sent elements (filtered, so the main loop skipped them).
        const trees = this._skippedFiltered;
        for (let i = 0; i < dirtyFiltered; i++) {
            const elTree = trees[i];
            trees[i] = undefined!; // a scratch slot must not keep a removed element alive
            if (elTree._fullSyncGen === f.genB || elTree.refId === undefined || !sentByBroadcast(elTree.ref, streams)) continue;
            enterFrame(f, elTree);
            encodeSchemaOps(f);
            closeChunk(f);
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
                    const elChanges = view.entriesOf(elRefId);
                    const elMetadata = elTree.encDescriptor.metadata;
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
        this.root.encodeEpoch++;
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

    /**
     * True when the next `encode()` / `encodeView()` has something to send,
     * including a stream backlog still draining under `maxPerTick` while
     * the rest of the state is idle.
     */
    get hasChanges(): boolean {
        const root = this.root;
        return root.changes.next !== undefined || (root.streamTrees.size !== 0 && this._hasStreamBacklog());
    }

    private _hasStreamBacklog(): boolean {
        const root = this.root;
        const broadcast = root.activeViews.size === 0;
        for (const stream of root.streamTrees) {
            if (broadcast
                ? streamHasBroadcastBacklog(stream)
                : streamHasViewBacklog(stream, root)) return true;
        }
        return false;
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
 * Tuning, not wire format: how far past a tree the pass looks for another of
 * its shape before opening a slot for it, and how many shapes can be open at
 * once. A shape that recurs further apart, or past the last slot, keeps one
 * chunk per tree.
 */
const RUN_PEEK = 8;
const RUN_SLOTS = 8;

/**
 * Same-shape trees that are not adjacent in a pass — an entity and its nested
 * child (`entity.position`) alternate in the dirty queue — collect here while
 * the pass walks on, and leave as one run per shape when the pass ends. A
 * deferred tree only ever moves later, so it stays behind the op that
 * introduces it. One table serves the shared pass and every view pass: they
 * never overlap, and each starts by resetting `open`.
 */
class RunSlots {
    desc: unknown[] = [];
    low: number[] = [];
    items: ChangeTree[][] = [];
    count: number[] = [];
    open = 0;

    constructor() {
        for (let s = 0; s < RUN_SLOTS; s++) {
            this.desc.push(undefined);
            this.low.push(0);
            this.items.push([]);
            this.count.push(0);
        }
    }

    /** The open slot `tree` can join, or -1. */
    find(tree: ChangeTree): number {
        const desc = tree.encDescriptor;
        const low = tree.dirtyLow;
        for (let s = 0; s < this.open; s++) {
            if (this.desc[s] === desc && this.low[s] === low) {
                return runContinues(this.items[s][0], tree, false) ? s : -1;
            }
        }
        return -1;
    }

    /** Open a slot with `first` (eligible) in it; false when all are taken. */
    take(first: ChangeTree): boolean {
        const s = this.open;
        if (s === RUN_SLOTS) return false;
        this.desc[s] = first.encDescriptor;
        this.low[s] = first.dirtyLow;
        this.items[s][0] = first;
        this.count[s] = 1;
        this.open = s + 1;
        return true;
    }
}

const _slots = /*#__PURE__*/ new RunSlots();

/** Is there a tree of this shape among the next `RUN_PEEK` of the queue? */
function peekShape(node: ChangeTreeNode | undefined, desc: unknown, low: number): boolean {
    for (let k = 0; node !== undefined && k < RUN_PEEK; k++, node = node.next) {
        if (node.changeTree.encDescriptor === desc && node.changeTree.dirtyLow === low) return true;
    }
    return false;
}

/** `peekShape` over a view's work list. */
function peekShapeSeq(trees: ChangeTree[], seq: number[], from: number, seqLen: number, desc: unknown, low: number): boolean {
    const end = (from + RUN_PEEK < seqLen) ? from + RUN_PEEK : seqLen;
    for (let q = from; q < end; q++) {
        const tree = trees[seq[q]];
        if (tree.encDescriptor === desc && tree.dirtyLow === low) return true;
    }
    return false;
}

/** End of a pass: every open slot leaves as a run, or as a plain chunk when nothing joined its first tree. */
function flushSlots(f: Frame): void {
    const slots = _slots;
    for (let s = 0; s < slots.open; s++) {
        const items = slots.items[s];
        const count = slots.count[s];
        const first = items[0];
        enterFrame(f, first);
        if (count === 1) {
            encodeTreeOps(f);
            closeChunk(f);
        } else {
            openRun(f, first, count - 1);
            for (let k = 1; k < count; k++) addRunMember(f, items[k]);
            endRun(f);
        }
        // a disposed state must not stay reachable
        for (let k = 0; k < count; k++) items[k] = undefined!;
        slots.desc[s] = undefined;
    }
    slots.open = 0;
}

/**
 * Run handling for `trees[seq[s]]` in a view pass. Returns how many further
 * work-list entries were emitted with it (a run of adjacent members), 0 when
 * it was deferred into a slot, -1 when it keeps its own chunk.
 */
function viewRun(f: Frame, trees: ChangeTree[], seq: number[], s: number, seqLen: number): number {
    const slots = _slots;
    const tree = trees[seq[s]];
    if (!tree.isFiltered) return -1;
    const slot = slots.find(tree);
    if (slot !== -1) {
        slots.items[slot][slots.count[slot]++] = tree;
    } else {
        const desc = tree.encDescriptor;
        const low = tree.dirtyLow;
        // (the caller's peek only ran while no slot was open)
        if (!peekShapeSeq(trees, seq, s + 1, seqLen, desc, low)) return -1;
        if (!runEligible(tree, true) || f.context.getTypeId(tree.ref.constructor) === undefined) return -1;
        let n = 0;
        while (s + 1 + n < seqLen) {
            const next = trees[seq[s + 1 + n]];
            if (!next.isFiltered || !runContinues(tree, next, true)) break;
            n++;
        }
        if (n > 0 && !peekShapeSeq(trees, seq, s + 1 + n, seqLen, desc, low)) {
            // adjacent members and nothing further on: straight into the buffer
            if (tree.isNew) tree._fullSyncGen = f.genB;
            enterFrame(f, tree);
            openRun(f, tree, n);
            for (let k = 1; k <= n; k++) {
                const member = trees[seq[s + k]];
                if (member.isNew) member._fullSyncGen = f.genB;
                addRunMember(f, member);
            }
            endRun(f);
            return n;
        }
        if (!slots.take(tree)) return -1;
    }
    if (tree.isNew) tree._fullSyncGen = f.genB; // no parent op inlines it meanwhile
    return 0;
}

/**
 * Shared patch loop: one chunk per dirty tree, skipping trees inlined earlier
 * in the pass. Reads flag bits and recorder state directly so the whole
 * per-tree + per-field path fits V8's cumulative inlining budget (no call
 * per tree). Returns how many dirty filtered trees it skipped into `skipped`
 * (when given).
 */
function encodeQueue(f: Frame, queue: ChangeTreeList, skipped: ChangeTree[] | undefined): number {
    let nSkipped = 0;
    const slots = _slots;
    slots.open = 0;
    let current: ChangeTreeList | ChangeTreeNode = queue;
    while (current = current.next) {
        const tree = (current as ChangeTreeNode).changeTree;
        if (tree._fullSyncGen === f.genB) continue;
        const flags = tree.flags;
        if ((flags & IS_FILTERED) !== 0) { // every op of a filtered tree belongs to the view pass
            if (skipped !== undefined && tree.has()) skipped[nSkipped++] = tree;
            continue;
        }
        const isSchema = tree._isSchema;
        if (isSchema ? (tree.dirtyLow | tree.dirtyHigh) === 0 : !tree.has()) continue;
        // only a fresh tree can be inlined by a later parent op → only those need the "emitted" stamp
        if ((flags & IS_NEW) !== 0) tree._fullSyncGen = f.genB;
        if (isSchema) {
            // same-shape run: trees of this class with the same dirty primitives.
            // Cheap checks first — an open slot, or the shape again within the
            // next few trees — so other ticks never pay the eligibility loop.
            const slot = (slots.open === 0) ? -1 : slots.find(tree);
            if (slot !== -1) {
                slots.items[slot][slots.count[slot]++] = tree;
                continue;
            }
            let node: ChangeTreeNode | undefined = (current as ChangeTreeNode).next;
            const desc = tree.encDescriptor;
            const low = tree.dirtyLow;
            // (`node !== undefined`: a lone or last tree skips even the call)
            if (node !== undefined && peekShape(node, desc, low) && runEligible(tree, false) && f.context.getTypeId(tree.ref.constructor) !== undefined) {
                let n = 0;
                while (node !== undefined && node.changeTree._fullSyncGen !== f.genB && (node.changeTree.flags & IS_FILTERED) === 0 && runContinues(tree, node.changeTree, false)) {
                    n++;
                    node = node.next;
                }
                if (n > 0 && !peekShape(node, desc, low)) {
                    // adjacent members and nothing further on: straight into the buffer
                    enterFrame(f, tree);
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
                if (slots.take(tree)) continue;
            }
        }
        enterFrame(f, tree);
        if (isSchema) encodeSchemaOps(f);
        else if (tree.encDescriptor.kind === KIND_ARRAY) encodeTreeOps(f);
        else encodeKeyedOps(f);
        closeChunk(f);
    }
    if (slots.open !== 0) flushSlots(f);
    return nSkipped;
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
    const visible = f.view!.isChangeTreeVisible(tree);
    if (stamp !== f.genB && visible) {
        enterFrame(f, tree);
        emitLiveChunk(f, forEachLiveWithCtx);
        closeChunk(f);
    }
    tree._fullSyncGen = f.genA;
    // Adding a tree to a view marks its ancestors visible, so nothing below
    // a filtered tree this view cannot see is visible either.
    if (!visible && tree.isFiltered) return;
    if (tree.encDescriptor.kind === KIND_MAP) {
        // forEachChild resolves each entry's wire index, which this walk never reads
        const ref: any = tree.ref;
        if (typeof ref[$childType] !== "string") {
            for (const value of ref.$items.values()) walkView(f, refTreeOf(value));
        }
        return;
    }
    forEachChildWithCtx(tree, f, walkViewChildCb);
}

function walkViewChildCb(f: Frame, child: ChangeTree, _index: any): void {
    walkView(f, child);
}

/**
 * Halve a per-view work list that last tick used under a quarter of: one
 * heavy tick (a join, a burst) would otherwise size it for the room's life.
 * Never to zero, which drops the backing store.
 */
function trimWorkList(list: number[] | undefined, used: number): void {
    if (list !== undefined && list.length > 64 && used * 4 < list.length) list.length = list.length >> 1;
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
