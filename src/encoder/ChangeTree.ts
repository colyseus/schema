import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refId, $refTypeFieldIndexes, $transientFieldIndexes, $unreliableFieldIndexes, $viewFieldIndexes, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import { type ChangeRecorder, SchemaChangeRecorder, CollectionChangeRecorder, popcount32 } from "./ChangeRecorder.js";
import { $numFields } from "../types/symbols.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import type { DecodeOperation } from "../decoder/DecodeOperation.js";

declare global {
    interface Object {
        // FIXME: not a good practice to extend globals here
        [$changes]?: ChangeTree;
        // [$refId]?: number;
        [$encoder]?: EncodeOperation,
        [$decoder]?: DecodeOperation,
    }
}

/**
 * Read one packed op-byte from inline ops storage. Pure arithmetic, no
 * `this`, so V8 inlines it into the encode-loop forEach without dispatch
 * cost. Mirror of `ChangeTree._opAt` for the case where the typed-array
 * branch was already excluded by the caller.
 */
function readInlineOpByte(low: number, high: number, index: number): number {
    const shift = (index & 3) << 3;
    return (index < 4)
        ? (low >>> shift) & 0xFF
        : (high >>> shift) & 0xFF;
}

export interface IRef {
    // FIXME: we only commented this out to allow mixing @colyseus/schema bundled types with server types in Cocos Creator
    // [$changes]?: ChangeTree;
    [$refId]?: number;
    [$getByIndex]?: (index: number, isEncodeAll?: boolean) => any;
    [$deleteByIndex]?: (index: number) => void;
}

export type Ref = Schema | ArraySchema | MapSchema | CollectionSchema | SetSchema;

// Linked list node for change trees
export interface ChangeTreeNode {
    changeTree: ChangeTree;
    next?: ChangeTreeNode;
    prev?: ChangeTreeNode;
    position: number; // Cached position in the linked list for O(1) lookup
}

// Linked list for change trees
export interface ChangeTreeList {
    next?: ChangeTreeNode;
    tail?: ChangeTreeNode;
}

// Linked list helper functions
export function createChangeTreeList(): ChangeTreeList {
    return { next: undefined, tail: undefined };
}

export interface ParentChain {
    ref: Ref;
    index: number;
    next?: ParentChain;
}

// Flags bitfield
const IS_FILTERED = 1;
const IS_VISIBILITY_SHARED = 2;
const IS_NEW = 4;
const IS_UNRELIABLE = 8;   // tree inherits unreliable classification from parent field
const IS_TRANSIENT = 16;   // tree inherits transient classification from parent field
const IS_STATIC = 32;      // tree inherits static classification from parent field (skip change tracking)

export class ChangeTree<T extends Ref = any> implements ChangeRecorder {
    ref: T;
    metadata: Metadata;

    root?: Root;

    // Inline single parent (the common case)
    parentRef?: Ref;
    _parentIndex?: number;
    extraParents?: ParentChain; // linked list for 2nd+ parents (rare: instance sharing)

    /**
     * Packed boolean flags:
     * bit 0: isFiltered (tree lives in a filtered subtree)
     * bit 1: isVisibilitySharedWithParent
     * bit 2: isNew
     * bit 3: isUnreliable (tree inherits unreliable from parent field's @unreliable)
     * bit 4: isTransient (tree inherits transient from parent field's @transient)
     */
    flags: number = IS_NEW;

    /**
     * Inline reliable-channel SchemaChangeRecorder state. For Schema-wrapping
     * trees, `this.recorder === this` — saves one object allocation per
     * Schema instance and removes a hidden-class deref on every mutation.
     * For Collection-wrapping trees, `recorder` points at a separately
     * allocated CollectionChangeRecorder; the `dirtyLow/dirtyHigh/ops`
     * fields below remain at their default values and are unused.
     */
    dirtyLow: number = 0;
    dirtyHigh: number = 0;

    /**
     * Inline ops storage for Schemas with ≤8 fields. Each number holds 4
     * packed op-bytes (8 bits × 4 = 32 bits per number). `opsLow` covers
     * fields 0..3, `opsHigh` covers fields 4..7. When set, `ops` is
     * undefined and reads/writes go through the inline path. Saves one
     * Uint8Array allocation per small Schema instance.
     */
    opsLow: number = 0;
    opsHigh: number = 0;
    ops?: Uint8Array; // only set for Schemas with >8 fields; undefined → inline path

    /**
     * Reliable dirty recorder — emitted by `Encoder.encode` on reliable
     * transport. Always set: `this` for Schema, a CollectionChangeRecorder
     * for collections.
     */
    recorder: ChangeRecorder;

    /**
     * Unreliable dirty recorder — emitted by `Encoder.encodeUnreliable` on
     * the unreliable transport channel. Lazy-allocated when the first
     * unreliable mutation is recorded.
     */
    unreliableRecorder?: ChangeRecorder;

    /**
     * When true, mutations on the associated ref are NOT tracked.
     * See `pause()` / `resume()` / `untracked(fn)`.
     */
    paused: boolean = false;

    /** Reliable-queue node reference (Root.changes linked list). */
    changesNode?: ChangeTreeNode;

    /** Unreliable-queue node reference (Root.unreliableChanges linked list). */
    unreliableChangesNode?: ChangeTreeNode;

    /**
     * Per-StateView visibility bitmaps. Bit `(viewId & 31)` in slot
     * `(viewId >> 5)` of `visibleViews` is set iff that view can see this
     * tree. Same encoding for `invisibleViews` (used to backfill on
     * subsequent view.add() calls). Replaces per-StateView WeakSet
     * lookups in the encode hot path with direct bitwise ops.
     *
     * Lazy: undefined for trees that have never participated in any view.
     */
    visibleViews?: number[];
    invisibleViews?: number[];

    /**
     * Per-(view, tag) bitmap. `tagViews.get(tag)[viewSlot] & viewBit` is set
     * iff the view has this tree associated with `tag`. Mirrors the
     * `visibleViews` shape but indexed by tag because the read site
     * (Schema filter check) already has `(tree, tag, view)` in hand.
     *
     * Lazy: undefined for trees that have never participated in a tagged
     * view.add() call. Custom tags only — DEFAULT_VIEW_TAG visibility lives
     * in `visibleViews`.
     */
    tagViews?: Map<number, number[]>;

    // Accessor properties for flags
    get isFiltered(): boolean { return (this.flags & IS_FILTERED) !== 0; }
    set isFiltered(v: boolean) { this.flags = v ? (this.flags | IS_FILTERED) : (this.flags & ~IS_FILTERED); }

    get isVisibilitySharedWithParent(): boolean { return (this.flags & IS_VISIBILITY_SHARED) !== 0; }
    set isVisibilitySharedWithParent(v: boolean) { this.flags = v ? (this.flags | IS_VISIBILITY_SHARED) : (this.flags & ~IS_VISIBILITY_SHARED); }

    get isNew(): boolean { return (this.flags & IS_NEW) !== 0; }
    set isNew(v: boolean) { this.flags = v ? (this.flags | IS_NEW) : (this.flags & ~IS_NEW); }

    get isUnreliable(): boolean { return (this.flags & IS_UNRELIABLE) !== 0; }
    set isUnreliable(v: boolean) { this.flags = v ? (this.flags | IS_UNRELIABLE) : (this.flags & ~IS_UNRELIABLE); }

    get isTransient(): boolean { return (this.flags & IS_TRANSIENT) !== 0; }
    set isTransient(v: boolean) { this.flags = v ? (this.flags | IS_TRANSIENT) : (this.flags & ~IS_TRANSIENT); }

    get isStatic(): boolean { return (this.flags & IS_STATIC) !== 0; }
    set isStatic(v: boolean) { this.flags = v ? (this.flags | IS_STATIC) : (this.flags & ~IS_STATIC); }

    /**
     * True if this tree carries at least one filtered field — either it
     * inherits `isFiltered` from a filtered ancestor, OR its Schema class
     * declares one or more @view-tagged fields. Used by StateView.addParentOf
     * to decide whether a parent must also be included in a view's bootstrap.
     */
    get hasFilteredFields(): boolean {
        return this.isFiltered || (this.metadata?.[$viewFieldIndexes] !== undefined);
    }

    /** Lazy-allocate the unreliable recorder on first unreliable mutation. */
    ensureUnreliableRecorder(): ChangeRecorder {
        if (this.unreliableRecorder === undefined) {
            const isSchema = Metadata.isValidInstance(this.ref);
            this.unreliableRecorder = isSchema
                ? new SchemaChangeRecorder((this.metadata?.[$numFields] ?? 0) as number)
                : new CollectionChangeRecorder();
        }
        return this.unreliableRecorder;
    }

    /**
     * Return true if the given (tree, index) pair is unreliable. Mirrors
     * the routing rule used at record time.
     */
    isFieldUnreliable(index: number): boolean {
        return this.isUnreliable || Metadata.hasUnreliableAtIndex(this.metadata, index);
    }

    /**
     * Return true if the given (tree, index) pair should skip change tracking.
     * A @static field is synchronized once via full-sync and never emits on
     * per-tick patches; mutations post-initial-set are silently ignored by
     * the tracker (the value still lives on the instance).
     */
    isFieldStatic(index: number): boolean {
        return this.isStatic || Metadata.hasStaticAtIndex(this.metadata, index);
    }

    constructor(ref: T) {
        this.ref = ref;
        this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

        const isSchema = Metadata.isValidInstance(ref);
        if (isSchema) {
            const numFields = (this.metadata?.[$numFields] ?? 0) as number;
            // POC: inline ops in opsLow/opsHigh for ≤8 fields. Only allocate
            // Uint8Array for larger schemas (rare in practice).
            if (numFields > 7) {
                this.ops = new Uint8Array(numFields + 1);
            }
            this.recorder = this; // inline self as the reliable-channel recorder
        } else {
            this.recorder = new CollectionChangeRecorder();
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Inline SchemaChangeRecorder implementation (only valid when Schema).
    // The same methods on CollectionChangeRecorder are still used through
    // `this.recorder` for Collection-wrapping trees.
    // ────────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────
    // Three small helpers that own ALL the inline-vs-array dispatch and
    // the dirty-mask update. The methods below compose them — no bitwise
    // math is duplicated outside this trio.
    // ────────────────────────────────────────────────────────────────────

    /** Read the op-byte at `index`. Dispatches between Uint8Array and inline storage. */
    private _opAt(index: number): number {
        const ops = this.ops;
        if (ops !== undefined) return ops[index];
        const shift = (index & 3) << 3;
        return (index < 4)
            ? (this.opsLow >>> shift) & 0xFF
            : (this.opsHigh >>> shift) & 0xFF;
    }

    /** Write the op-byte at `index` WITHOUT touching the dirty mask. */
    private _opPut(index: number, op: OPERATION): void {
        const ops = this.ops;
        if (ops !== undefined) {
            ops[index] = op;
            return;
        }
        const shift = (index & 3) << 3;
        const mask = ~(0xFF << shift);
        if (index < 4) this.opsLow = (this.opsLow & mask) | (op << shift);
        else this.opsHigh = (this.opsHigh & mask) | (op << shift);
    }

    /** Mark `index` dirty in the per-tick mask. */
    private _markDirty(index: number): void {
        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    record(index: number, op: OPERATION): void {
        const prev = this._opAt(index);
        if (prev === 0) {
            this._opPut(index, op);
        } else if (prev === OPERATION.DELETE) {
            this._opPut(index, OPERATION.DELETE_AND_ADD);
        }
        // else: existing op (ADD / DELETE_AND_ADD) — preserve op-byte.
        this._markDirty(index);
    }

    recordDelete(index: number, op: OPERATION): void {
        this._opPut(index, op);
        this._markDirty(index);
    }

    recordRaw(index: number, op: OPERATION): void {
        this._opPut(index, op);
        this._markDirty(index);
    }

    recordPure(_op: OPERATION): void {
        throw new Error("ChangeTree (Schema): pure operations are not supported");
    }

    operationAt(index: number): OPERATION | undefined {
        const op = this._opAt(index);
        return op === 0 ? undefined : op;
    }

    setOperationAt(index: number, op: OPERATION): void {
        // No dirty-mark side effect — overwrite only.
        this._opPut(index, op);
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        let low = this.dirtyLow;
        let high = this.dirtyHigh;
        const ops = this.ops;
        if (ops !== undefined) {
            while (low !== 0) {
                const bit = low & -low;
                const fieldIndex = 31 - Math.clz32(bit);
                low ^= bit;
                cb(fieldIndex, ops[fieldIndex]);
            }
            while (high !== 0) {
                const bit = high & -high;
                const fieldIndex = 31 - Math.clz32(bit) + 32;
                high ^= bit;
                cb(fieldIndex, ops[fieldIndex]);
            }
        } else {
            // Inline path: only fields 0..7 possible (numFields ≤ 8 ⇒
            // dirtyHigh stays 0).
            const ol = this.opsLow;
            const oh = this.opsHigh;
            while (low !== 0) {
                const bit = low & -low;
                const fieldIndex = 31 - Math.clz32(bit);
                low ^= bit;
                cb(fieldIndex, readInlineOpByte(ol, oh, fieldIndex));
            }
        }
    }

    forEachWithCtx<C>(ctx: C, cb: (ctx: C, index: number, op: OPERATION) => void): void {
        let low = this.dirtyLow;
        let high = this.dirtyHigh;
        const ops = this.ops;
        if (ops !== undefined) {
            while (low !== 0) {
                const bit = low & -low;
                const fieldIndex = 31 - Math.clz32(bit);
                low ^= bit;
                cb(ctx, fieldIndex, ops[fieldIndex]);
            }
            while (high !== 0) {
                const bit = high & -high;
                const fieldIndex = 31 - Math.clz32(bit) + 32;
                high ^= bit;
                cb(ctx, fieldIndex, ops[fieldIndex]);
            }
        } else {
            const ol = this.opsLow;
            const oh = this.opsHigh;
            while (low !== 0) {
                const bit = low & -low;
                const fieldIndex = 31 - Math.clz32(bit);
                low ^= bit;
                cb(ctx, fieldIndex, readInlineOpByte(ol, oh, fieldIndex));
            }
        }
    }

    size(): number {
        return popcount32(this.dirtyLow) + popcount32(this.dirtyHigh);
    }

    has(): boolean {
        return (this.dirtyLow | this.dirtyHigh) !== 0;
    }

    reset(): void {
        this.dirtyLow = 0;
        this.dirtyHigh = 0;
        if (this.ops !== undefined) this.ops.fill(0);
        else { this.opsLow = 0; this.opsHigh = 0; }
    }

    shift(_shiftIndex: number): void {
        throw new Error("ChangeTree (Schema): shift is not supported");
    }

    // ────────────────────────────────────────────────────────────────────
    // Hot-path setRoot / setParent recursion. forEachChildWithCtx + a
    // hoisted callback avoids one closure allocation per attached child.
    // ────────────────────────────────────────────────────────────────────

    setRoot(root: Root) {
        this.root = root;

        const isNewChangeTree = this.root.add(this);

        this.checkIsFiltered(this.parent, this.parentIndex, isNewChangeTree);

        // Recursively set root on child structures (closure-free hot path).
        if (isNewChangeTree) {
            this.forEachChildWithCtx(root, _setRootChildCb);
        }
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.addParent(parent, parentIndex);

        // avoid setting parents with empty `root`
        if (!root) { return; }

        const isNewChangeTree = root.add(this);

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;
            this.checkIsFiltered(parent, parentIndex, isNewChangeTree);
        }

        // assign same parent on child structures (closure-free hot path).
        // setParent recurses, so each depth gets its own ctx from a pool
        // that grows to the recursion depth (typically tree height = 3-5).
        if (isNewChangeTree) {
            let ctx = _setParentCtxPool[_setParentDepth];
            if (ctx === undefined) {
                ctx = { parentRef: undefined!, root: undefined! };
                _setParentCtxPool[_setParentDepth] = ctx;
            }
            ctx.parentRef = this.ref;
            ctx.root = root;
            _setParentDepth++;
            this.forEachChildWithCtx(ctx, _setParentChildCb);
            _setParentDepth--;
        }
    }

    forEachChild(callback: (change: ChangeTree, at: any) => void) {
        //
        // assign same parent on child structures
        //
        if ((this.ref as any)[$childType]) {
            if (typeof ((this.ref as any)[$childType]) !== "string") {
                // MapSchema / ArraySchema, etc.
                for (const [key, value] of (this.ref as MapSchema).entries()) {
                    if (!value) { continue; } // sparse arrays can have undefined values
                    callback(value[$changes], (this.ref as any)._collectionIndexes?.[key] ?? key);
                };
            }

        } else {
            for (const index of this.metadata?.[$refTypeFieldIndexes] ?? []) {
                const field = this.metadata[index as any as number];
                const value = this.ref[field.name as keyof Ref];
                if (!value) { continue; }
                callback(value[$changes], index);
            }
        }
    }

    /**
     * Closure-free variant of {@link forEachChild}. Hot setRoot / setParent
     * recursion called this once per new Schema instance attached to the
     * tree — the per-call closure was the #1 JS hotspot in profile-baseline.
     * Pass an explicit `ctx` so callers can hoist the callback to module
     * scope and avoid the allocation.
     */
    forEachChildWithCtx<C>(ctx: C, callback: (ctx: C, change: ChangeTree, at: any) => void) {
        const ref = this.ref as any;
        if (ref[$childType]) {
            if (typeof ref[$childType] !== "string") {
                const collectionIndexes = ref._collectionIndexes;
                for (const [key, value] of (ref as MapSchema).entries()) {
                    if (!value) { continue; }
                    callback(ctx, value[$changes], collectionIndexes?.[key] ?? key);
                }
            }
        } else {
            const metadata = this.metadata;
            const indexes = metadata?.[$refTypeFieldIndexes];
            if (!indexes) return;
            for (let i = 0, len = indexes.length; i < len; i++) {
                const index = indexes[i];
                const field = metadata[index];
                const value = (this.ref as any)[field.name];
                if (!value) { continue; }
                callback(ctx, value[$changes], index);
            }
        }
    }

    /**
     * Walk all currently-populated non-transient indexes on this tree,
     * emitting each index once. Used by Root.add (re-stage), Encoder.encodeAll,
     * and StateView.add to derive full-sync output from the live structure.
     *
     * Transient fields (`@transient`) are skipped — they're delivered only
     * on tick patches and not persisted to snapshots. Collections whose
     * parent field is @transient inherit the skip (`tree.isTransient`).
     */
    forEachLive(callback: (index: number) => void): void {
        const ref = this.ref as any;

        if (ref[$childType] !== undefined) {
            // Collection inheriting @transient from parent field: skip entirely.
            if (this.isTransient) return;

            // Collection types: dispatch by shape.
            if (Array.isArray(ref.items)) {
                // ArraySchema
                const items = ref.items as any[];
                for (let i = 0, len = items.length; i < len; i++) {
                    if (items[i] !== undefined) callback(i);
                }
            } else if (ref.journal !== undefined) {
                // MapSchema
                for (const [index, key] of ref.journal.keyByIndex as Map<number, any>) {
                    if (ref.$items.has(key)) callback(index);
                }
            } else if (ref.$items !== undefined) {
                // SetSchema / CollectionSchema (key === wire index)
                for (const index of (ref.$items as Map<number, any>).keys()) {
                    callback(index);
                }
            }
        } else {
            // Schema: walk declared fields. `null` is treated as absent —
            // the setter records a DELETE when a field is set to null or
            // undefined, so it should not appear in full-sync output.
            const metadata = this.metadata;
            if (!metadata) return;
            const numFields = (metadata[$numFields] ?? -1) as number;
            const transientIndexes = metadata[$transientFieldIndexes];
            for (let i = 0; i <= numFields; i++) {
                const field = metadata[i as any];
                if (field === undefined) continue;
                if (transientIndexes && transientIndexes.includes(i)) continue;
                const value = ref[field.name];
                if (value !== undefined && value !== null) callback(i);
            }
        }
    }

    operation(op: OPERATION) {
        if (this.paused || this.isStatic) return;
        // Pure ops (CLEAR/REVERSE) apply to collections; collections inherit
        // their channel at tree level via `isUnreliable`.
        if (this.isUnreliable) {
            this.ensureUnreliableRecorder().recordPure(op);
            this.root?.enqueueUnreliable(this);
        } else {
            this.recorder.recordPure(op);
            this.root?.enqueueChangeTree(this);
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        if (this.paused || this.isFieldStatic(index)) return;

        if (this.isFieldUnreliable(index)) {
            // unreliable channel — rare; falls through to generic dispatch
            const r = this.ensureUnreliableRecorder();
            const prev = r.operationAt(index);
            const op = (!prev) ? operation
                     : (prev === OPERATION.DELETE) ? OPERATION.DELETE_AND_ADD
                     : prev;
            r.record(index, op);
            this.root?.enqueueUnreliable(this);
            return;
        }

        // Reliable path: split into Schema-inline vs Collection so each call
        // site is monomorphic in its inline cache (drops bimorphic
        // recorder.record dispatch from the hot setter path).
        if (this.recorder === this) {
            // SCHEMA fast-path — direct call to our own `record` (monomorphic
            // at this call site: only ChangeTree.prototype.record is ever seen).
            this.record(index, operation);
        } else {
            // COLLECTION path — recorder is always CollectionChangeRecorder here.
            const r = this.recorder;
            const prev = r.operationAt(index);
            const op = (!prev) ? operation
                     : (prev === OPERATION.DELETE) ? OPERATION.DELETE_AND_ADD
                     : prev;
            r.record(index, op);
        }

        this.root?.enqueueChangeTree(this);
    }

    shiftChangeIndexes(shiftIndex: number) {
        //
        // Used only during ArraySchema#unshift().
        // Array shifts apply to both channels if either has dirty entries.
        //
        this.recorder.shift(shiftIndex);
        this.unreliableRecorder?.shift(shiftIndex);
    }

    indexedOperation(index: number, operation: OPERATION) {
        if (this.paused || this.isFieldStatic(index)) return;

        if (this.isFieldUnreliable(index)) {
            this.ensureUnreliableRecorder().recordRaw(index, operation);
            this.root?.enqueueUnreliable(this);
            return;
        }

        // Monomorphic split: Schema fast-path inline; Collection path keeps
        // a stable single-shape call site.
        if (this.recorder === this) {
            // SCHEMA fast-path — direct call (monomorphic).
            this.recordRaw(index, operation);
        } else {
            this.recorder.recordRaw(index, operation);
        }
        this.root?.enqueueChangeTree(this);
    }

    getType(index?: number) {
        return (
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            (this.ref as any)[$childType] || // ArraySchema | MapSchema | SetSchema | CollectionSchema
            this.metadata[index].type // Schema
        );
    }

    getChange(index: number) {
        return this.recorder.operationAt(index);
    }

    // ────────────────────────────────────────────────────────────────────
    // Change-tracking control API
    // ────────────────────────────────────────────────────────────────────

    /** Stop recording mutations until resume() is called. */
    pause(): void {
        this.paused = true;
    }

    /** Re-enable automatic change tracking. */
    resume(): void {
        this.paused = false;
    }

    /**
     * Run `fn` with change tracking paused, then restore the previous state.
     */
    untracked<T>(fn: () => T): T {
        const wasPaused = this.paused;
        this.paused = true;
        try {
            return fn();
        } finally {
            this.paused = wasPaused;
        }
    }

    /**
     * Manually mark a field/index as dirty so it gets emitted in the next
     * encode(). Useful after paused mutations or when a nested object
     * was mutated without triggering the schema setter.
     */
    markDirty(index: number, operation: OPERATION = OPERATION.ADD): void {
        const wasPaused = this.paused;
        this.paused = false;
        try {
            this.change(index, operation);
        } finally {
            this.paused = wasPaused;
        }
    }

    //
    // used during `.encode()`
    //
    getValue(index: number, isEncodeAll: boolean = false) {
        //
        // `isEncodeAll` param is only used by ArraySchema
        //
        return (this.ref as any)[$getByIndex](index, isEncodeAll);
    }

    delete(index: number, operation?: OPERATION) {
        if (index === undefined) {
            try {
                throw new Error(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index '${index}'`);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        if (this.paused || this.isFieldStatic(index)) {
            return this.getValue(index);
        }

        const unreliable = this.isFieldUnreliable(index);
        if (unreliable) {
            this.ensureUnreliableRecorder().recordDelete(index, operation ?? OPERATION.DELETE);
        } else {
            this.recorder.recordDelete(index, operation ?? OPERATION.DELETE);
        }

        const previousValue = this.getValue(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            //
            // FIXME: this.root is "undefined"
            //
            // This method is being called at decoding time when a DELETE operation is found.
            //
            this.root?.remove(previousValue[$changes]);
        }

        if (unreliable) {
            this.root?.enqueueUnreliable(this);
        } else {
            this.root?.enqueueChangeTree(this);
        }

        return previousValue;
    }

    /** Clear the reliable dirty bucket after a reliable encode pass. */
    endEncode() {
        this.recorder.reset();
        this.changesNode = undefined;

        (this.ref as any)[$onEncodeEnd]?.();

        this.isNew = false;
    }

    /** Clear the unreliable dirty bucket after an unreliable encode pass. */
    endEncodeUnreliable() {
        this.unreliableRecorder?.reset();
        this.unreliableChangesNode = undefined;

        (this.ref as any)[$onEncodeEnd]?.();
    }

    discard() {
        (this.ref as any)[$onEncodeEnd]?.();
        this.recorder.reset();
        this.unreliableRecorder?.reset();
    }

    /**
     * Recursively discard all changes from this, and child structures.
     * (Used in tests only)
     */
    discardAll() {
        this.recorder.forEach((index, _op) => {
            if (index < 0) return;
            const value = this.getValue(index);
            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });
        this.unreliableRecorder?.forEach((index, _op) => {
            if (index < 0) return;
            const value = this.getValue(index);
            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });
        this.discard();
    }

    get changed() {
        return this.recorder.has() || (this.unreliableRecorder?.has() ?? false);
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number, _isNewChangeTree: boolean) {
        this._checkInheritedFlags(parent, parentIndex);

        // Static trees never track per-tick changes — skip the queue entirely.
        // Full-sync reaches them via structural walk (forEachChild).
        if (this.isStatic) return;

        // Mutations that happened before setRoot (e.g. class-field initializers)
        // recorded into the appropriate recorder but couldn't enqueue yet.
        // Reconcile both queues now.
        if (this.recorder.has()) {
            this.root?.enqueueChangeTree(this);
        }
        if (this.unreliableRecorder?.has()) {
            this.root?.enqueueUnreliable(this);
        }
        // Fresh tree with nothing recorded: still enqueue into its primary
        // queue so the tree is reachable for its first mutation cycle.
        if (!this.recorder.has() && !(this.unreliableRecorder?.has())) {
            if (this.isUnreliable) {
                this.root?.enqueueUnreliable(this);
            } else {
                this.root?.enqueueChangeTree(this);
            }
        }
    }

    /**
     * Inherit filter / unreliable / transient classification from the
     * parent field's annotation. Collections (MapSchema / ArraySchema /
     * etc.) inherit these from the Schema field that holds them.
     */
    protected _checkInheritedFlags(parent: Ref, parentIndex: number) {
        if (!parent) { return; }

        //
        // ArraySchema | MapSchema - get the child type
        // (if refType is typeof string, the parentFiltered[key] below will always be invalid)
        //
        const refType = Metadata.isValidInstance(this.ref)
            ? this.ref.constructor
            : (this.ref as any)[$childType];

        let parentChangeTree: ChangeTree;

        let parentIsCollection = !Metadata.isValidInstance(parent);
        if (parentIsCollection) {
            parentChangeTree = parent[$changes];
            parent = parentChangeTree.parent;
            parentIndex = parentChangeTree.parentIndex;

        } else {
            parentChangeTree = parent[$changes]
        }

        const parentConstructor = parent?.constructor as typeof Schema;
        const parentMetadata = parentConstructor?.[Symbol.metadata];

        // Unreliable/transient/static inheritance — from parent schema's field annotation.
        const fieldIsUnreliable = Metadata.hasUnreliableAtIndex(parentMetadata, parentIndex);
        const fieldIsTransient = Metadata.hasTransientAtIndex(parentMetadata, parentIndex);
        const fieldIsStatic = Metadata.hasStaticAtIndex(parentMetadata, parentIndex);
        const becameUnreliable = !this.isUnreliable && (parentChangeTree.isUnreliable || fieldIsUnreliable);
        const becameStatic = !this.isStatic && (parentChangeTree.isStatic || fieldIsStatic);
        this.isUnreliable = parentChangeTree.isUnreliable || fieldIsUnreliable;
        this.isTransient = parentChangeTree.isTransient || fieldIsTransient;
        this.isStatic = parentChangeTree.isStatic || fieldIsStatic;

        // If this tree just became static via inheritance, discard any
        // entries that may have been recorded before the parent was
        // assigned (e.g. `new Config().assign({...})` populates the
        // recorder before the Config instance is attached to its parent).
        // Static trees ship their state via structural walk only; any
        // per-tick dirty state is moot and would leak post-first-sync.
        if (becameStatic) {
            this.recorder.reset();
            this.unreliableRecorder?.reset();
        }
        // If this tree just became unreliable via inheritance AND it already
        // has entries in the reliable recorder (recorded before the parent
        // was assigned — e.g. `new Item().assign({...})` populates item's
        // recorder before it's pushed into an unreliable collection),
        // promote them to the unreliable recorder.
        else if (becameUnreliable && this.recorder.has()) {
            const src = this.recorder;
            const dst = this.ensureUnreliableRecorder();
            src.forEach((index, op) => {
                if (index < 0) dst.recordPure(op);
                else dst.record(index, op);
            });
            src.reset();
        }

        // Filtered inheritance — only run the expensive lookup when the root
        // context has filters at all.
        if (!this.root?.types.hasFilters) return;

        let key = `${this.root.types.getTypeId(refType as typeof Schema)}`;
        if (parentConstructor) {
            key += `-${this.root.types.schemas.get(parentConstructor)}`;
        }
        key += `-${parentIndex}`;

        const fieldHasViewTag = Metadata.hasViewTagAtIndex(parentMetadata, parentIndex);

        this.isFiltered = parentChangeTree.isFiltered
            || this.root.types.parentFiltered[key]
            || fieldHasViewTag;

        if (this.isFiltered) {
            this.isVisibilitySharedWithParent = (
                parentChangeTree.isFiltered &&
                typeof (refType) !== "string" &&
                !fieldHasViewTag &&
                parentIsCollection
            );
        }
    }

    /**
     * Get the immediate parent
     */
    get parent(): Ref | undefined {
        return this.parentRef;
    }

    /**
     * Get the immediate parent index
     */
    get parentIndex(): number | undefined {
        return this._parentIndex;
    }

    /**
     * Add a parent to the chain
     */
    addParent(parent: Ref, index: number) {
        // Check if this parent already exists anywhere in the chain
        if (this.parentRef) {
            if (this.parentRef[$changes] === parent[$changes]) {
                // Primary parent matches — update index
                this._parentIndex = index;
                return;
            }

            // Check extra parents for duplicate
            if (this.hasParent((p, _) => p[$changes] === parent[$changes])) {
                // Match old behavior: update primary parent's index
                this._parentIndex = index;
                return;
            }
        }

        if (this.parentRef === undefined) {
            // First parent — store inline
            this.parentRef = parent;
            this._parentIndex = index;
        } else {
            // Push current inline parent to extraParents, set new as primary
            this.extraParents = {
                ref: this.parentRef,
                index: this._parentIndex,
                next: this.extraParents
            };
            this.parentRef = parent;
            this._parentIndex = index;
        }
    }

    /**
     * Remove a parent from the chain
     * @param parent - The parent to remove
     * @returns true if parent was found and removed
     */
    removeParent(parent: Ref = this.parent): boolean {
        //
        // FIXME: it is required to check against `$changes` here because
        // ArraySchema is instance of Proxy
        //
        if (this.parentRef && this.parentRef[$changes] === parent[$changes]) {
            // Removing inline parent — promote first extra parent if exists
            if (this.extraParents) {
                this.parentRef = this.extraParents.ref;
                this._parentIndex = this.extraParents.index;
                this.extraParents = this.extraParents.next;
            } else {
                this.parentRef = undefined;
                this._parentIndex = undefined;
            }
            return true;
        }

        // Search extra parents
        let current = this.extraParents;
        let previous = null;
        while (current) {
            if (current.ref[$changes] === parent[$changes]) {
                if (previous) {
                    previous.next = current.next;
                } else {
                    this.extraParents = current.next;
                }
                return true;
            }
            previous = current;
            current = current.next;
        }
        return this.parentRef === undefined;
    }

    /**
     * Find a specific parent in the chain
     */
    findParent(predicate: (parent: Ref, index: number) => boolean): ParentChain | undefined {
        // Check inline parent first
        if (this.parentRef && predicate(this.parentRef, this._parentIndex)) {
            return { ref: this.parentRef, index: this._parentIndex };
        }

        let current = this.extraParents;
        while (current) {
            if (predicate(current.ref, current.index)) {
                return current;
            }
            current = current.next;
        }
        return undefined;
    }

    /**
     * Check if this ChangeTree has a specific parent
     */
    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return this.findParent(predicate) !== undefined;
    }

    /**
     * Get all parents as an array (for debugging/testing)
     */
    getAllParents(): Array<{ ref: Ref, index: number }> {
        const parents: Array<{ ref: Ref, index: number }> = [];
        if (this.parentRef) {
            parents.push({ ref: this.parentRef, index: this._parentIndex });
        }
        let current = this.extraParents;
        while (current) {
            parents.push({ ref: current.ref, index: current.index });
            current = current.next;
        }
        return parents;
    }

}

// Hoisted callbacks used by ChangeTree.setRoot / setParent to avoid
// per-call closure allocation in the recursive attach path.

function _setRootChildCb(root: Root, child: ChangeTree, _index: any): void {
    if (child.root !== root) {
        child.setRoot(root);
    } else {
        root.add(child); // increment refCount
    }
}

interface SetParentCtx { parentRef: Ref; root: Root; }
// Pool of ctx objects, indexed by setParent recursion depth. Grows to
// max depth seen (typically tree height = 3-5 in bench), then stays put.
const _setParentCtxPool: SetParentCtx[] = [];
let _setParentDepth = 0;

function _setParentChildCb(ctx: SetParentCtx, child: ChangeTree, index: any): void {
    if (child.root === ctx.root) {
        ctx.root.add(child);
        ctx.root.moveNextToParent(child);
        return;
    }
    child.setParent(ctx.parentRef, ctx.root, index);
}
