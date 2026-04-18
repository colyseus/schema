/**
 * ChangeTree — the per-`Ref` mutation tracker attached via `$changes`.
 *
 * This file owns: class shape (fields, flags, ctor), inline
 * ChangeRecorder implementation (record / forEach / …), mutation API
 * (change / delete / operation / …), and encode lifecycle (endEncode /
 * discard / …). Helpers split out into ./changeTree/:
 *
 *   - parentChain.ts     addParent / removeParent / find / has / getAll
 *   - liveIteration.ts   forEachLive
 *   - inheritedFlags.ts  filter / unreliable / transient / static inheritance
 *   - treeAttachment.ts  setRoot / setParent / forEachChild(+WithCtx)
 *
 * Public surface on ChangeTree is unchanged — methods are thin pass-throughs
 * into the helpers. V8 inlines the pass-throughs; the runtime shape stays
 * a single class to preserve hidden-class + IC behavior.
 */
import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refId, $viewFieldIndexes, $numFields, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import { type ChangeRecorder, type ICollectionChangeRecorder, SchemaChangeRecorder, CollectionChangeRecorder, popcount32 } from "./ChangeRecorder.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import { type EncodeDescriptor, getEncodeDescriptor } from "./EncodeDescriptor.js";
import type { DecodeOperation } from "../decoder/DecodeOperation.js";

import {
    addParent as _addParent, removeParent as _removeParent,
    findParent as _findParent, hasParent as _hasParent,
    getAllParents as _getAllParents,
} from "./changeTree/parentChain.js";
import { forEachLive as _forEachLive, forEachLiveWithCtx as _forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import {
    setRoot as _setRoot, setParent as _setParent,
    forEachChild as _forEachChild, forEachChildWithCtx as _forEachChildWithCtx,
} from "./changeTree/treeAttachment.js";

declare global {
    interface Object {
        // FIXME: not a good practice to extend globals here
        [$changes]?: ChangeTree;
        // [$refId]?: number;
        [$encoder]?: EncodeOperation,
        [$decoder]?: DecodeOperation,
    }
}

// Pure arithmetic, no `this` — V8 inlines into encode-loop forEach.
// Mirror of `ChangeTree._opAt` for the inline-ops-only branch.
function readInlineOpByte(low: number, high: number, index: number): number {
    const shift = (index & 3) << 3;
    return (index < 4)
        ? (low >>> shift) & 0xFF
        : (high >>> shift) & 0xFF;
}

// Adapter that lets `forEach(cb)` delegate to `forEachWithCtx(cb, _invokeNoCtx)` —
// no per-call closure allocation. See ChangeRecorder.ts for the same pattern.
const _invokeNoCtx = (
    cb: (index: number, op: OPERATION) => void,
    index: number,
    op: OPERATION,
) => cb(index, op);

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

// Flags bitfield. *_UNRELIABLE / _TRANSIENT / _STATIC mirror the parent
// field's annotation — inherited at setParent/setRoot time.
const IS_FILTERED = 1, IS_VISIBILITY_SHARED = 2, IS_NEW = 4;
const IS_UNRELIABLE = 8, IS_TRANSIENT = 16, IS_STATIC = 32;

export class ChangeTree<T extends Ref = any> implements ChangeRecorder {
    ref: T;
    metadata: Metadata;

    /**
     * Per-class cache of encoder fn / filter fn / isSchema / filterBitmask /
     * metadata, looked up once at construction. The encode loop reads
     * `tree.encDescriptor` and never touches `ref.constructor` again. See
     * EncodeDescriptor.ts.
     */
    encDescriptor: EncodeDescriptor;

    root?: Root;

    // Inline single parent (the common case)
    parentRef?: Ref;
    _parentIndex?: number;
    extraParents?: ParentChain; // linked list for 2nd+ parents (rare: instance sharing)

    // Packed boolean flags. See IS_* constants above for bit layout.
    flags: number = IS_NEW;

    // Schema vs Collection discriminator. Set once in ctor, never changes —
    // per-tree-stable branch for inline ChangeRecorder dispatch.
    _isSchema: boolean = false;

    // Inline reliable SchemaChangeRecorder state (valid only if _isSchema).
    dirtyLow: number = 0;
    dirtyHigh: number = 0;

    // Inline ops for Schemas with ≤8 fields (4 op-bytes per number).
    // When `ops` is set (>8 fields), reads/writes go through the Uint8Array.
    opsLow: number = 0;
    opsHigh: number = 0;
    ops?: Uint8Array;

    // Inline reliable CollectionChangeRecorder state (valid only if !_isSchema).
    // `collDirty` is allocated in the ctor. `collPureOps` stays undefined
    // until the first CLEAR/REVERSE (most workloads never hit this).
    collDirty?: Map<number, OPERATION>;
    collPureOps?: Array<[number, OPERATION]>;

    // Lazy-allocated unreliable-channel recorder (rare — opt-in via @unreliable).
    unreliableRecorder?: ChangeRecorder;

    // When true, mutations on the ref are NOT tracked. See pause/resume/untracked.
    paused: boolean = false;

    changesNode?: ChangeTreeNode;            // Root.changes linked-list node
    unreliableChangesNode?: ChangeTreeNode;  // Root.unreliableChanges linked-list node

    // Per-StateView visibility bitmaps. Bit `(viewId & 31)` in slot
    // `(viewId >> 5)` is set iff the view can see this tree. Replaces
    // per-view WeakSet lookups with direct bitwise ops.
    // Lazy: undefined until the tree participates in any view.
    visibleViews?: number[];
    invisibleViews?: number[];

    // Per-(view, tag) bitmap, indexed by tag. Custom tags only —
    // DEFAULT_VIEW_TAG visibility lives in `visibleViews`.
    tagViews?: Map<number, number[]>;

    // Accessor properties for flags
    get isFiltered() { return (this.flags & IS_FILTERED) !== 0; }
    set isFiltered(v: boolean) { this.flags = v ? (this.flags | IS_FILTERED) : (this.flags & ~IS_FILTERED); }
    get isVisibilitySharedWithParent() { return (this.flags & IS_VISIBILITY_SHARED) !== 0; }
    set isVisibilitySharedWithParent(v: boolean) { this.flags = v ? (this.flags | IS_VISIBILITY_SHARED) : (this.flags & ~IS_VISIBILITY_SHARED); }
    get isNew() { return (this.flags & IS_NEW) !== 0; }
    set isNew(v: boolean) { this.flags = v ? (this.flags | IS_NEW) : (this.flags & ~IS_NEW); }
    get isUnreliable() { return (this.flags & IS_UNRELIABLE) !== 0; }
    set isUnreliable(v: boolean) { this.flags = v ? (this.flags | IS_UNRELIABLE) : (this.flags & ~IS_UNRELIABLE); }
    get isTransient() { return (this.flags & IS_TRANSIENT) !== 0; }
    set isTransient(v: boolean) { this.flags = v ? (this.flags | IS_TRANSIENT) : (this.flags & ~IS_TRANSIENT); }
    get isStatic() { return (this.flags & IS_STATIC) !== 0; }
    set isStatic(v: boolean) { this.flags = v ? (this.flags | IS_STATIC) : (this.flags & ~IS_STATIC); }

    // True iff tree inherits `isFiltered` OR its Schema class declares any
    // @view-tagged fields. StateView.addParentOf uses this to decide whether
    // a parent must be included in a view's bootstrap.
    get hasFilteredFields(): boolean {
        return this.isFiltered || (this.metadata?.[$viewFieldIndexes] !== undefined);
    }

    ensureUnreliableRecorder(): ChangeRecorder {
        if (this.unreliableRecorder === undefined) {
            const isSchema = Metadata.isValidInstance(this.ref);
            this.unreliableRecorder = isSchema
                ? new SchemaChangeRecorder((this.metadata?.[$numFields] ?? 0) as number)
                : new CollectionChangeRecorder();
        }
        return this.unreliableRecorder;
    }

    isFieldUnreliable(index: number): boolean {
        if (this.isUnreliable) return true;
        // Class-level fast path: most schemas have zero unreliable fields,
        // so the per-mutation check resolves without the symbol-keyed
        // metadata lookup. For schemas that DO have unreliable fields, the
        // bitmask answers fields 0-31 in one bitwise op (no Array.includes
        // linear scan). Fields ≥32 always fall back to the metadata lookup
        // (same limitation as filterBitmask — bitmask only covers low 32).
        const desc = this.encDescriptor;
        if (!desc.hasAnyUnreliable) return false;
        if (index < 32) return (desc.unreliableBitmask & (1 << index)) !== 0;
        return Metadata.hasUnreliableAtIndex(this.metadata, index);
    }

    // @static fields sync once via full-sync; post-init mutations are ignored
    // by the tracker (the value still lives on the instance).
    isFieldStatic(index: number): boolean {
        if (this.isStatic) return true;
        const desc = this.encDescriptor;
        if (!desc.hasAnyStatic) return false;
        if (index < 32) return (desc.staticBitmask & (1 << index)) !== 0;
        return Metadata.hasStaticAtIndex(this.metadata, index);
    }

    constructor(ref: T) {
        this.ref = ref;

        // Single per-class lookup that subsumes Symbol.metadata,
        // isValidInstance, $encoder, $filter, and the filter bitmask.
        // After this, the encode loop never touches `ref.constructor`.
        const desc = getEncodeDescriptor(ref);
        this.encDescriptor = desc;
        this.metadata = desc.metadata;

        const isSchema = desc.isSchema;
        this._isSchema = isSchema;

        // Assign every optional slot so Schema and Collection trees share
        // one hidden-class transition path (tsconfig useDefineForClassFields=false
        // otherwise leaves uninitialized class fields absent from the shape).
        this.ops = undefined;
        this.collDirty = undefined;
        this.collPureOps = undefined;

        if (isSchema) {
            const numFields = (this.metadata?.[$numFields] ?? 0) as number;
            if (numFields > 7) this.ops = new Uint8Array(numFields + 1);
        } else {
            this.collDirty = new Map();
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Inline ChangeRecorder implementation. Each method branches once on
    // `_isSchema` (per-tree-stable → predictable branch). Kills one
    // CollectionChangeRecorder+Map allocation per Collection tree.
    // ────────────────────────────────────────────────────────────────────

    // Schema-only helpers that own all inline-vs-array dispatch.
    private _opAt(index: number): number {
        const ops = this.ops;
        if (ops !== undefined) return ops[index];
        const shift = (index & 3) << 3;
        return (index < 4)
            ? (this.opsLow >>> shift) & 0xFF
            : (this.opsHigh >>> shift) & 0xFF;
    }

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

    private _markDirty(index: number): void {
        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    record(index: number, op: OPERATION): void {
        if (this._isSchema) {
            const prev = this._opAt(index);
            if (prev === 0) this._opPut(index, op);
            else if (prev === OPERATION.DELETE) this._opPut(index, OPERATION.DELETE_AND_ADD);
            // else: existing ADD / DELETE_AND_ADD — preserve op-byte.
            this._markDirty(index);
        } else {
            const dirty = this.collDirty!;
            const prev = dirty.get(index);
            const finalOp = (prev === undefined)
                ? op
                : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
            dirty.set(index, finalOp);
        }
    }

    recordDelete(index: number, op: OPERATION): void {
        if (this._isSchema) {
            this._opPut(index, op);
            this._markDirty(index);
        } else {
            this.collDirty!.set(index, op);
        }
    }

    recordRaw(index: number, op: OPERATION): void {
        if (this._isSchema) {
            this._opPut(index, op);
            this._markDirty(index);
        } else {
            this.collDirty!.set(index, op);
        }
    }

    recordPure(op: OPERATION): void {
        if (this._isSchema) {
            throw new Error("ChangeTree (Schema): pure operations are not supported");
        }
        (this.collPureOps ??= []).push([this.collDirty!.size, op]);
    }

    operationAt(index: number): OPERATION | undefined {
        if (this._isSchema) {
            const op = this._opAt(index);
            return op === 0 ? undefined : op;
        }
        return this.collDirty!.get(index);
    }

    setOperationAt(index: number, op: OPERATION): void {
        // Schema: overwrite only (no dirty-mark). Collection: overwrite iff key exists (legacy).
        if (this._isSchema) {
            this._opPut(index, op);
        } else {
            const dirty = this.collDirty!;
            if (dirty.has(index)) dirty.set(index, op);
        }
    }

    // Cold-path delegate: all `forEach` callers are debug/dump utilities
    // (Schema.ts debug output, utils.ts change dump, discardAll in tests).
    // The hot encode loop uses `forEachWithCtx` directly. See ChangeRecorder.ts
    // for the same adapter pattern.
    forEach(cb: (index: number, op: OPERATION) => void): void {
        this.forEachWithCtx(cb, _invokeNoCtx);
    }

    forEachWithCtx<C>(ctx: C, cb: (ctx: C, index: number, op: OPERATION) => void): void {
        if (this._isSchema) {
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
            return;
        }
        const dirty = this.collDirty!;
        const pure = this.collPureOps;
        if (pure !== undefined && pure.length > 0) {
            let pureIdx = 0, i = 0;
            for (const [index, op] of dirty) {
                while (pureIdx < pure.length && pure[pureIdx][0] <= i) {
                    const pureOp = pure[pureIdx++][1];
                    cb(ctx, -pureOp, pureOp);
                }
                cb(ctx, index, op);
                i++;
            }
            while (pureIdx < pure.length) {
                const pureOp = pure[pureIdx++][1];
                cb(ctx, -pureOp, pureOp);
            }
        } else {
            for (const [index, op] of dirty) cb(ctx, index, op);
        }
    }

    size(): number {
        if (this._isSchema) return popcount32(this.dirtyLow) + popcount32(this.dirtyHigh);
        return this.collDirty!.size + (this.collPureOps?.length ?? 0);
    }

    has(): boolean {
        if (this._isSchema) return (this.dirtyLow | this.dirtyHigh) !== 0;
        return this.collDirty!.size > 0 || (this.collPureOps !== undefined && this.collPureOps.length > 0);
    }

    reset(): void {
        if (this._isSchema) {
            this.dirtyLow = 0;
            this.dirtyHigh = 0;
            if (this.ops !== undefined) this.ops.fill(0);
            else { this.opsLow = 0; this.opsHigh = 0; }
            return;
        }
        this.collDirty!.clear();
        if (this.collPureOps !== undefined) this.collPureOps.length = 0;
    }

    shift(shiftIndex: number): void {
        if (this._isSchema) throw new Error("ChangeTree (Schema): shift is not supported");
        const src = this.collDirty!;
        const dst = new Map<number, OPERATION>();
        for (const [idx, val] of src) dst.set(idx + shiftIndex, val);
        this.collDirty = dst;
    }

    // Tree attachment + child iteration — see ./changeTree/treeAttachment.ts.
    setRoot(root: Root): void { _setRoot(this, root); }
    setParent(parent: Ref, root?: Root, parentIndex?: number): void { _setParent(this, parent, root, parentIndex); }
    forEachChild(cb: (change: ChangeTree, at: any) => void): void { _forEachChild(this, cb); }
    forEachChildWithCtx<C>(ctx: C, cb: (ctx: C, change: ChangeTree, at: any) => void): void {
        _forEachChildWithCtx(this, ctx, cb);
    }
    forEachLive(cb: (index: number) => void): void { _forEachLive(this, cb); }
    forEachLiveWithCtx<C>(ctx: C, cb: (ctx: C, index: number) => void): void {
        _forEachLiveWithCtx(this, ctx, cb);
    }

    operation(op: OPERATION) {
        if (this.paused || this.isStatic) return;
        // Pure ops (CLEAR/REVERSE) only emit from collection trees — the
        // recorder here is always a CollectionChangeRecorder by construction.
        if (this.isUnreliable) {
            (this.ensureUnreliableRecorder() as ICollectionChangeRecorder).recordPure(op);
            this.root?.enqueueUnreliable(this);
        } else {
            this.recordPure(op);
            this.root?.enqueueChangeTree(this);
        }
    }

    /**
     * Route a field-level mutation to the reliable or unreliable channel
     * and enqueue into the matching queue. Shared by `change` and
     * `indexedOperation`; `raw=true` bypasses DELETE→ADD merge
     * (ArraySchema positional writes), `raw=false` merges inside `record`.
     *
     * Note: record() on both channels handles DELETE→ADD merge internally,
     * so callers do not need to pre-compute the merged op.
     *
     * `@unreliable` is decoration-time-validated to apply only to primitive
     * fields (see annotations.ts), so the per-field unreliable flag here
     * always means "primitive value updates" — the structural-ADD-routes-
     * reliable footgun for ref-type fields can't reach this code path.
     */
    private _routeAndRecord(index: number, op: OPERATION, raw: boolean): void {
        if (this.paused || this.isFieldStatic(index)) return;
        if (this.isFieldUnreliable(index)) {
            const r = this.ensureUnreliableRecorder();
            if (raw) r.recordRaw(index, op);
            else r.record(index, op);
            this.root?.enqueueUnreliable(this);
            return;
        }
        if (raw) this.recordRaw(index, op);
        else this.record(index, op);
        this.root?.enqueueChangeTree(this);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        this._routeAndRecord(index, operation, false);
    }

    indexedOperation(index: number, operation: OPERATION) {
        this._routeAndRecord(index, operation, true);
    }

    // ArraySchema#unshift(): apply shift to both channels.
    // Unreliable recorder on an array is always a CollectionChangeRecorder.
    shiftChangeIndexes(shiftIndex: number) {
        this.shift(shiftIndex);
        (this.unreliableRecorder as ICollectionChangeRecorder | undefined)?.shift(shiftIndex);
    }

    // Collection: child type from ref (["string"] | {map:"string"} | …).
    // Schema: field type from metadata.
    getType(index?: number) {
        return (this.ref as any)[$childType] || this.metadata[index].type;
    }

    getChange(index: number) {
        return this.operationAt(index);
    }

    // ────────────────────────────────────────────────────────────────────
    // Change-tracking control API
    // ────────────────────────────────────────────────────────────────────

    pause(): void { this.paused = true; }
    resume(): void { this.paused = false; }

    untracked<T>(fn: () => T): T {
        const wasPaused = this.paused;
        this.paused = true;
        try { return fn(); }
        finally { this.paused = wasPaused; }
    }

    // Manually mark a field dirty for the next encode(). Useful after a
    // paused mutation or a nested mutation that bypassed the setter.
    markDirty(index: number, operation: OPERATION = OPERATION.ADD): void {
        const wasPaused = this.paused;
        this.paused = false;
        try { this.change(index, operation); }
        finally { this.paused = wasPaused; }
    }

    // used during `.encode()` — `isEncodeAll` is only consumed by ArraySchema.
    getValue(index: number, isEncodeAll: boolean = false) {
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

        if (this.paused || this.isFieldStatic(index)) return this.getValue(index);

        const unreliable = this.isFieldUnreliable(index);
        if (unreliable) this.ensureUnreliableRecorder().recordDelete(index, operation ?? OPERATION.DELETE);
        else this.recordDelete(index, operation ?? OPERATION.DELETE);

        const previousValue = this.getValue(index);

        // FIXME: `this.root` is "undefined" when called at decode time.
        if (previousValue && previousValue[$changes]) this.root?.remove(previousValue[$changes]);

        if (unreliable) this.root?.enqueueUnreliable(this);
        else this.root?.enqueueChangeTree(this);

        return previousValue;
    }

    // Clear the reliable dirty bucket after a reliable encode pass.
    endEncode() {
        this.reset();
        this.changesNode = undefined;
        (this.ref as any)[$onEncodeEnd]?.();
        this.isNew = false;
    }

    // Clear the unreliable dirty bucket after an unreliable encode pass.
    endEncodeUnreliable() {
        this.unreliableRecorder?.reset();
        this.unreliableChangesNode = undefined;
        (this.ref as any)[$onEncodeEnd]?.();
    }

    discard() {
        (this.ref as any)[$onEncodeEnd]?.();
        this.reset();
        this.unreliableRecorder?.reset();
    }

    // Recursively discard all changes on this + child structures. Tests only.
    discardAll() {
        const discardChild = (index: number) => {
            if (index < 0) return;
            const value = this.getValue(index);
            if (value && value[$changes]) value[$changes].discardAll();
        };
        this.forEach(discardChild);
        this.unreliableRecorder?.forEach(discardChild);
        this.discard();
    }

    get changed() {
        return this.has() || (this.unreliableRecorder?.has() ?? false);
    }

    // ────────────────────────────────────────────────────────────────────
    // Parent chain — implementations in ./changeTree/parentChain.ts.
    // ────────────────────────────────────────────────────────────────────

    /** Immediate parent (primary). See `extraParents` for the 2nd+ chain. */
    get parent(): Ref | undefined { return this.parentRef; }
    get parentIndex(): number | undefined { return this._parentIndex; }

    addParent(parent: Ref, index: number): void { _addParent(this, parent, index); }

    /** @returns true if parent was found and removed */
    removeParent(parent: Ref = this.parent): boolean { return _removeParent(this, parent); }

    findParent(predicate: (parent: Ref, index: number) => boolean): ParentChain | undefined {
        return _findParent(this, predicate);
    }

    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return _hasParent(this, predicate);
    }

    getAllParents(): Array<{ ref: Ref, index: number }> { return _getAllParents(this); }

}
