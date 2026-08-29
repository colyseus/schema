import type { Schema } from "../Schema.js";
import { TypeContext } from "../types/TypeContext.js";
import { $changes } from "../types/symbols.js";
import type { Iterator } from "../encoding/decode.js";
import { Root } from "../encoder/Root.js";
import { Encoder, discardQueue, growSharedBuffer } from "../encoder/Encoder.js";
import type { StateView } from "../encoder/StateView.js";
import { IS_FILTERED, IS_NEW, type ChangeTree, type ChangeTreeList, type ChangeTreeNode } from "../encoder/ChangeTree.js";
import { forEachLiveWithCtx } from "../encoder/changeTree/liveIteration.js";
import { forEachChildWithCtx } from "../encoder/changeTree/treeAttachment.js";
import { drainFilterRefresh } from "../encoder/changeTree/inheritedFlags.js";
import { getV6ClassInfo } from "./classInfo.js";
import {
    MODE_DRAIN, MODE_PATCH, MODE_SNAPSHOT,
    closeChunk, emitViewEntry, encodeCollectionOps, encodeSchemaOps, encodeTreeOps, enterFrame, fullSyncCb6, passFrame, releaseFrames, type Frame,
} from "./EncodeOperation6.js";

/**
 * v6 wire-format encoder (PoC). Reuses the v5 change tracking (`ChangeTree`,
 * `Root`, `StateView`) untouched; only emission differs:
 *
 * - chunks `uvarint(refId) uvarint(len) ops` instead of `255 refId`;
 * - fresh instances ride inline as a body of the parent's ADD;
 * - `encodeAll` is one nested root chunk;
 * - `encodeView` / `encodeAllView` return `[shared, viewSlice]` — no concat —
 *   and per-tree filtered chunks are encoded once per tick and memcpy'd.
 */
export class Encoder6<T extends Schema = any> {
    sharedBuffer: Uint8Array = new Uint8Array(Encoder.BUFFER_SIZE);

    context: TypeContext;
    state: T;
    root: Root;

    /** Negative per-pass stamps written into `ChangeTree._fullSyncGen` (v5 only writes positive). */
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
        this.context = TypeContext.cache(state.constructor as typeof Schema);
        this.root = root ?? new Root(this.context);
        this.state = state;
        this.state[$changes].setRoot(this.root);
    }

    private _beginPass(buffer: Uint8Array, it: Iterator, view: StateView | undefined, emitFiltered: boolean, mode: number): Frame {
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
        f.genA = --this._gen;
        f.genB = --this._gen;
        return f;
    }

    // ── snapshot ────────────────────────────────────────────────────────

    encodeAll(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_SNAPSHOT);
        const rootTree = this.state[$changes];
        rootTree._fullSyncGen = f.genB;
        enterFrame(f, rootTree);
        forEachLiveWithCtx(rootTree, f, fullSyncCb6);
        closeChunk(f);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encodeAll(it, buffer);
        }
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
        return [buffer.subarray(0, sharedOffset), buffer.subarray(viewOffset, it.offset)];
    }

    // ── patch ───────────────────────────────────────────────────────────

    /** Shared (unfiltered) per-tick patch. */
    encode(it: Iterator = { offset: 0 }, buffer: Uint8Array = this.sharedBuffer): Uint8Array {
        const initialOffset = it.offset;
        const f = this._beginPass(buffer, it, undefined, false, MODE_PATCH);
        encodeQueue(f, this.root.changes);

        if (it.offset > buffer.byteLength) {
            buffer = this._resizeBuffer(buffer, it.offset);
            it.offset = initialOffset;
            return this.encode(it, buffer);
        }
        return buffer.subarray(initialOffset, it.offset);
    }

    /**
     * Per-view patch: `view.changes` drain (visibility bootstrap, with inline
     * bodies for newly-visible subtrees) followed by the tick's filtered ops
     * visible to this view. Returns the shared slice and the view slice.
     */
    encodeView(view: StateView, sharedOffset: number, it: Iterator, buffer: Uint8Array = this.sharedBuffer): [Uint8Array, Uint8Array] {
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
                    const end = this._cacheEnd[i];
                    if (it.offset + (end - start) <= buffer.byteLength) {
                        buffer.set(this._scratch.subarray(start, end), it.offset);
                    }
                    it.offset += end - start;
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
            return this.encodeView(view, sharedOffset, it, buffer);
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
            const info = getV6ClassInfo(desc, tree.refTarget.constructor);
            if (!include && tree._isSchema && desc.hasAnyView) {
                include = (tree.dirtyLow & desc.filterBitmask) !== 0
                    || (tree.dirtyHigh !== 0 && info.hasTagAbove32);
            }
            if (!include) continue;
            if (tree._isSchema) {
                // pure-primitive chunk → a function of (tree, view's custom tags); safe to memcpy
                canCache = (tree.dirtyLow & info.refTypeBitmask) === 0 && (tree.dirtyHigh === 0 || !info.hasRefFieldAbove32);
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
        this._scratch.set(buffer.subarray(start, end), this._scratchOffset);
        this._cacheKey[i] = key;
        this._cacheStart[i] = this._scratchOffset;
        this._cacheEnd[i] = this._scratchOffset + len;
        this._scratchOffset += len;
    }

    // ── lifecycle ───────────────────────────────────────────────────────

    discardChanges(): void {
        discardQueue(this.root, this.root.changes);
        this._tickPrepared = false;
        releaseFrames(); // here, not per pass: a call in `encode()` costs inlining budget on the hot chain
    }

    get hasChanges(): boolean {
        return this.root.changes.next !== undefined;
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
        if (isSchema) encodeSchemaOps(f); else encodeCollectionOps(f);
        closeChunk(f);
    }
}

/**
 * Structural DFS for `encodeAllView` (v5 `_fullSyncWalk` shape): visible
 * trees emit their filtered-side live fields as a chunk unless an inline body
 * already carried them; recursion continues either way so public trees with
 * tagged fields deeper down are reached.
 */
function walkView(f: Frame, tree: ChangeTree): void {
    const stamp = tree._fullSyncGen;
    if (stamp === f.genA) return;
    if (stamp !== f.genB && f.view!.isChangeTreeVisible(tree)) {
        enterFrame(f, tree);
        forEachLiveWithCtx(tree, f, fullSyncCb6);
        closeChunk(f);
    }
    tree._fullSyncGen = f.genA;
    forEachChildWithCtx(tree, f, walkViewChildCb);
}

function walkViewChildCb(f: Frame, child: ChangeTree, _index: any): void {
    walkView(f, child);
}

function tagKey(view: StateView, tree: ChangeTree): number {
    const bits = getV6ClassInfo(tree.encDescriptor, tree.refTarget.constructor).customTagBits;
    let key = 0;
    for (let i = 0; i < bits.length; i++) {
        if (view.hasTagOnTree(tree, bits[i])) key |= bits[i];
    }
    return key;
}
