/**
 * ChangeTree — the per-`Ref` mutation tracker attached via `$changes`.
 *
 * This file owns: class shape (fields, flags, ctor), the inline Schema
 * change recorder (record / forEach / …), mutation API (change / delete /
 * …), and the encode lifecycle (endEncode / discard / …). Collections keep
 * their own recorder (`rec`: an `ArrayLog` or a `KeyedRecorder`, created by
 * the class's `[$recorder]` factory) and record on it directly; the tree
 * only owns attachment, flags, queue membership and view bitmaps for them.
 *
 * Helpers split out into ./changeTree/:
 *
 *   - parentChain.ts     addParent / removeParent / find / has / getAll
 *   - liveIteration.ts   forEachLive
 *   - inheritedFlags.ts  filter / unreliable / patchOnly / static inheritance
 *   - treeAttachment.ts  setRoot / setParent / forEachChild(+WithCtx)
 *
 * Public surface on ChangeTree is unchanged — methods are thin pass-throughs
 * into the helpers. V8 inlines the pass-throughs; the runtime shape stays
 * a single class to preserve hidden-class + IC behavior.
 */
import { ARRAY_OP, KIND_ARRAY, KIND_MAP, KIND_SCHEMA, OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $onEncodeEnd, $getByIndex, $refId, $refTypeFieldIndexes, $numFields, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";
import type { StreamSchema } from "../types/custom/StreamSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import { type ChangeRecorder, SchemaChangeRecorder, popcount32 } from "./ChangeRecorder.js";
import { type EncodeDescriptor, getEncodeDescriptor } from "./EncodeDescriptor.js";
import type { ArrayLog } from "./ArrayLog.js";
import type { KeyedRecorder } from "./KeyedRecorder.js";
import { $items } from "../types/symbols.js";
import { arrCopy } from "../types/custom/arrayOps.js";

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

// Augmenting the global `Object` interface is a deliberate trade-off:
// any Schema / collection instance — regardless of which bundled
// `@colyseus/schema` version created it — can be duck-typed against
// these Symbol-keyed slots. Narrower shapes (e.g. on `IRef`) would break
// cross-version interop where server-bundled types coexist with client-
// bundled ones in the same process.
declare global {
    interface Object {
        [$changes]?: ChangeTree;
    }
}

// Pure arithmetic, no `this` — V8 inlines into encode-loop forEach.
// Mirror of `ChangeTree._opAt` for the inline-ops-only branch.
export function readInlineOpByte(low: number, high: number, index: number): number {
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
    // `[$changes]?: ChangeTree;` is intentionally omitted here — see the
    // `declare global` augmentation above. Narrowing to IRef would break
    // cross-version interop (Cocos Creator bundles server- and client-
    // side schema types together; a strict declaration here would reject
    // one side's instances at compile time).
    [$refId]?: number;
    // `$getByIndex` / `$deleteByIndex` are required on every actual ref
    // the decoder / encoder ever touches (Schema + every collection
    // implements both). Keeping them non-optional lets hot-path call
    // sites skip the `(ref as any)` cast.
    [$getByIndex](index: number, isEncodeAll?: boolean): any;
    [$deleteByIndex](index: number): void;
}

export type Ref = Schema | ArraySchema | MapSchema | CollectionSchema | SetSchema | StreamSchema;

// Linked list node for change trees
export interface ChangeTreeNode {
    changeTree: ChangeTree;
    next?: ChangeTreeNode;
    prev?: ChangeTreeNode;
    position: number; // strictly increasing along the list — O(1) order test
}

// Linked list for change trees
export interface ChangeTreeList {
    next?: ChangeTreeNode;
    tail?: ChangeTreeNode;
    nextPosition: number; // monotonic per drain cycle (resets when list empties)
}

// Linked list helper functions
export function createChangeTreeList(): ChangeTreeList {
    return { next: undefined, tail: undefined, nextPosition: 0 };
}

/**
 * Live node in a tree's parent chain — mutating one edits the chain. Only
 * `parentChain.ts` should hold these.
 */
export interface ParentChain {
    ref: Ref;
    index: number;
    next?: ParentChain;
}

/**
 * Detached copy of one parent link, handed out by the query helpers. Distinct
 * from `ParentChain` on purpose: it carries no `next`, so it cannot be walked
 * as if it were the chain, and it is readonly, so it cannot be mistaken for a
 * way to move a parent's index.
 */
export interface ParentEntry {
    readonly ref: Ref;
    readonly index: number;
}

// Flags bitfield. *_UNRELIABLE / _PATCH_ONLY / _STATIC mirror the parent
// field's annotation — inherited at setParent/setRoot time.
export const IS_FILTERED = 1, IS_VISIBILITY_SHARED = 2, IS_NEW = 4;
export const IS_UNRELIABLE = 8, IS_PATCH_ONLY = 16, IS_FULL_STATE_ONLY = 32;
// Collection tree attached to a parent field annotated `.stream()` —
// drives the encoder's priority/broadcast pass. Set in inheritedFlags
// so both `t.stream(X)` (via StreamSchema's `$isStream` brand) and
// `t.map(X).stream()` / `t.set(X).stream()` route through the same
// emission machinery.
export const IS_STREAM_COLLECTION = 64;
// Set by `recycle()` (Schema.reset / pooling): the tree's values are live
// but its dirty buckets were cleared, so `Root.add` must re-stage every
// populated field as ADD when the instance re-enters a tree. Without this,
// only fields assigned after `pool.acquire()` would reach the wire — the
// retained ones (constructor-initialized children) would never be encoded.
export const NEEDS_RESTAGE = 128;
// Queued in `Root.pendingFilterRefresh` — the tree's parent-edge set changed
// (instance sharing gained/lost an edge) and `isFiltered` /
// `isVisibilitySharedWithParent` must be re-derived from the LIVE edges
// before the next encode. See inheritedFlags.refreshFilterState.
export const PENDING_FILTER_REFRESH = 256;
/**
 * Flags a child inherits from its parent's own transitive state via
 * `checkInheritedFlags`. Read as a bitwise mask so the inheritance step
 * is a single OR instead of three getter/setter pairs.
 *
 * `IS_UNRELIABLE` is intentionally excluded: `@unreliable` is rejected
 * at decoration time for ref-type fields (see `Metadata.setUnreliable`)
 * because an unreliable ADD/DELETE could leave the decoder unable to
 * interpret later packets referencing an orphan refId. Tree-level
 * unreliable is therefore dead on every Schema/Collection tree today;
 * the bit and its machinery are kept in place so this can be
 * reconsidered if a safe semantics (e.g. reliable ADD + unreliable
 * field mutations only) is designed later.
 */
export const INHERITABLE_FLAGS = IS_PATCH_ONLY | IS_FULL_STATE_ONLY;

/** Re-stage callback for Schema trees (`restage()`): every live field as a fresh ADD on its channel. */
const _restageSchemaCb = (tree: ChangeTree, fieldIndex: number): void => {
    if (tree.isFieldUnreliable(fieldIndex)) {
        tree.ensureUnreliableRecorder().record(fieldIndex, OPERATION.ADD);
    } else {
        tree.record(fieldIndex, OPERATION.ADD);
    }
};

const _restageKeyedCb = (rec: KeyedRecorder, index: number): void => {
    rec.add(index, OPERATION.ADD);
};

export class ChangeTree<T extends Ref = any> implements ChangeRecorder {
    ref: T;

    /**
     * Non-Proxy target of `ref` for encoder hot-path reads. For
     * `ArraySchema`, `ref` is the Proxy users interact with (its `set` trap
     * tracks index writes); `refTarget` is the raw array underneath. For every
     * other type `refTarget === ref`. Consumers that need the user-facing
     * identity (debug output, callback parents) keep using `ref`.
     */
    refTarget: T;

    /**
     * Indexable element storage of an ArraySchema (`refTarget` itself for
     * the Array subclass, its plain `items` array for the internal-array
     * experiment); `refTarget` for every other type.
     */
    elements: any;

    /** True when `ref` is an ArraySchema. */
    get isArray(): boolean { return this.encDescriptor.kind === KIND_ARRAY; }

    metadata: Metadata;

    /**
     * Per-class cache of filter fn / isSchema / metadata / per-field arrays,
     * looked up once at construction. The encode loop reads
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

    /**
     * Per-walk visit stamp written by the encoder's snapshot / patch passes.
     * A tree is "already visited by the current pass" iff its stamp equals
     * the pass's generation; any later encounter of the same tree (shared
     * refs reachable through multiple parents) short-circuits on the
     * equality check instead of recursing or re-emitting.
     */
    _fullSyncGen: number = 0;

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

    /**
     * Collection recorder (valid only if !_isSchema): an `ArrayLog` for
     * ArraySchema, a `KeyedRecorder` for Map / Set / Collection / Stream.
     * Undefined on Schema trees and on the fieldless-Schema edge case (a
     * Schema class with no declared fields classifies as non-Schema and
     * has no recorder factory) — every read below is guarded.
     */
    rec?: ArrayLog | KeyedRecorder;

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

    // Per-(view, tag) bitmap, indexed by tag. Custom tags only —
    // DEFAULT_VIEW_TAG visibility lives in `visibleViews`.
    tagViews?: Map<number, number[]>;

    /**
     * Per-view subscription bitmap — same layout as `visibleViews`. Set by
     * `StateView.subscribe(collection)` to mark the view as persistently
     * interested in this collection's contents. When a new child is
     * attached to a subscribed collection (setParent hook), it's
     * auto-propagated to every subscribed view (force-shipped for
     * Array/Map/Set/Collection; enqueued into per-view pending for
     * streams). Undefined until the first subscribe.
     */
    subscribedViews?: number[];

    // Accessor properties for flags
    get isFiltered() { return (this.flags & IS_FILTERED) !== 0; }
    set isFiltered(v: boolean) { this.flags = v ? (this.flags | IS_FILTERED) : (this.flags & ~IS_FILTERED); }
    get isVisibilitySharedWithParent() { return (this.flags & IS_VISIBILITY_SHARED) !== 0; }
    set isVisibilitySharedWithParent(v: boolean) { this.flags = v ? (this.flags | IS_VISIBILITY_SHARED) : (this.flags & ~IS_VISIBILITY_SHARED); }
    get isNew() { return (this.flags & IS_NEW) !== 0; }
    set isNew(v: boolean) { this.flags = v ? (this.flags | IS_NEW) : (this.flags & ~IS_NEW); }
    get isUnreliable() { return (this.flags & IS_UNRELIABLE) !== 0; }
    set isUnreliable(v: boolean) { this.flags = v ? (this.flags | IS_UNRELIABLE) : (this.flags & ~IS_UNRELIABLE); }
    get isPatchOnly() { return (this.flags & IS_PATCH_ONLY) !== 0; }
    set isPatchOnly(v: boolean) { this.flags = v ? (this.flags | IS_PATCH_ONLY) : (this.flags & ~IS_PATCH_ONLY); }
    get isFullStateOnly() { return (this.flags & IS_FULL_STATE_ONLY) !== 0; }
    set isFullStateOnly(v: boolean) { this.flags = v ? (this.flags | IS_FULL_STATE_ONLY) : (this.flags & ~IS_FULL_STATE_ONLY); }
    get isStreamCollection() { return (this.flags & IS_STREAM_COLLECTION) !== 0; }
    set isStreamCollection(v: boolean) { this.flags = v ? (this.flags | IS_STREAM_COLLECTION) : (this.flags & ~IS_STREAM_COLLECTION); }
    get needsRestage() { return (this.flags & NEEDS_RESTAGE) !== 0; }
    set needsRestage(v: boolean) { this.flags = v ? (this.flags | NEEDS_RESTAGE) : (this.flags & ~NEEDS_RESTAGE); }

    // True iff tree inherits `isFiltered` OR its Schema class declares any
    // @view-tagged fields. StateView.addParentOf uses this to decide whether
    // a parent must be included in a view's bootstrap. Reads the class-level
    // "any viewed field" flag that `EncodeDescriptor` precomputes — same
    // pattern as `hasAnyFullStateOnly` / `hasAnyUnreliable` / `hasAnyStream`.
    get hasFilteredFields(): boolean {
        return this.isFiltered || this.encDescriptor.hasAnyView;
    }

    /**
     * True when mutations on the ref must be recorded. Collections consult
     * this before touching their recorder (`paused` and `@fullStateOnly`
     * short-circuit recording entirely).
     */
    get tracking(): boolean {
        return !this.paused && (this.flags & IS_FULL_STATE_ONLY) === 0;
    }

    ensureUnreliableRecorder(): ChangeRecorder {
        if (this.unreliableRecorder === undefined) {
            if (!this._isSchema) {
                throw new Error("ChangeTree: collections never carry an unreliable recorder");
            }
            this.unreliableRecorder = new SchemaChangeRecorder((this.metadata?.[$numFields] ?? 0) as number);
        }
        return this.unreliableRecorder;
    }

    isFieldUnreliable(index: number): boolean {
        // Tree-level `isUnreliable` is disabled — @unreliable is rejected
        // on ref-type fields at decoration time, so no tree ever carries
        // the flag. Kept as a comment in case a safe semantics is added
        // later (see INHERITABLE_FLAGS rationale).
        // if (this.isUnreliable) return true;
        // Class-level fast path: most schemas have zero unreliable fields,
        // so the per-mutation check resolves without the symbol-keyed
        // metadata lookup. For schemas that DO have unreliable fields, the
        // bitmask answers fields 0-31 in one bitwise op (no Array.includes
        // linear scan). Fields ≥32 always fall back to the metadata lookup
        // (shift counts wrap at 32, so the bitmask only covers the low 32).
        const desc = this.encDescriptor;
        if (!desc.hasAnyUnreliable) return false;
        if (index < 32) return (desc.unreliableBitmask & (1 << index)) !== 0;
        return Metadata.hasUnreliableAtIndex(this.metadata, index);
    }

    // @static fields sync once via full-sync; post-init mutations are ignored
    // by the tracker (the value still lives on the instance).
    isFieldFullStateOnly(index: number): boolean {
        if (this.isFullStateOnly) return true;
        const desc = this.encDescriptor;
        if (!desc.hasAnyFullStateOnly) return false;
        if (index < 32) return (desc.fullStateOnlyBitmask & (1 << index)) !== 0;
        return Metadata.hasFullStateOnlyAtIndex(this.metadata, index);
    }

    // `t.stream(...)` collection fields — encoded via per-view priority/budget
    // gate instead of emitting all dirty ADDs in one tick. Class-level short
    // circuit avoids the metadata chase on schemas that carry no stream fields.
    isFieldStream(index: number): boolean {
        const desc = this.encDescriptor;
        if (!desc.hasAnyStream) return false;
        if (index < 32) return (desc.streamBitmask & (1 << index)) !== 0;
        return Metadata.hasStreamAtIndex(this.metadata, index);
    }

    constructor(ref: T, refTarget: T = ref) {
        this.ref = ref;
        // Raw (non-Proxy) target, passed explicitly by ArraySchema's ctor —
        // the only proxied type. Defaulting to `ref` for everything else
        // skips a guaranteed-miss megamorphic `$proxyTarget` probe per
        // construction.
        this.refTarget = refTarget;
        this.elements = (refTarget as any)[$items] ?? refTarget;

        // Single per-class lookup that subsumes Symbol.metadata,
        // isValidInstance, $filter, the recorder factory and the bitmasks.
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
        this.rec = undefined;

        if (isSchema) {
            const numFields = (this.metadata?.[$numFields] ?? 0) as number;
            if (numFields > 7) this.ops = new Uint8Array(numFields + 1);
        } else {
            this.rec = desc.newRecorder?.();
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Inline Schema ChangeRecorder implementation. Collections never reach
    // these — they record on `rec` directly.
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
        const prev = this._opAt(index);
        if (prev === 0) this._opPut(index, op);
        else if (prev === OPERATION.DELETE) this._opPut(index, OPERATION.DELETE_AND_ADD);
        // Promote ADD → DELETE_AND_ADD when a ref is replaced in the
        // same tick. Otherwise the on-wire op collapses to plain ADD
        // and the decoder's `refs` map leaks the displaced refId —
        // harmless on its own, but refId pooling turns that leak into
        // a catastrophic rebinding when the refId is later reused.
        else if (prev === OPERATION.ADD && op === OPERATION.DELETE_AND_ADD) {
            this._opPut(index, OPERATION.DELETE_AND_ADD);
        }
        // else: existing ADD / DELETE_AND_ADD — preserve op-byte.
        this._markDirty(index);
    }

    recordDelete(index: number, op: OPERATION): void {
        this._opPut(index, op);
        this._markDirty(index);
    }

    operationAt(index: number): OPERATION | undefined {
        if (this._isSchema) {
            const op = this._opAt(index);
            return op === 0 ? undefined : op;
        }
        return this.rec?.opAt(index);
    }

    // Cold-path delegate: all `forEach` callers are debug/dump utilities
    // (Schema.ts debug output, utils.ts change dump, discardAll in tests).
    // The hot encode loop walks the storage directly.
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
        const rec = this.rec;
        if (rec === undefined) return;
        if (this.encDescriptor.kind === KIND_ARRAY) {
            // Debug view of the array log: one ADD per pushed / inserted /
            // re-stated value, REPLACE per SET, DELETE per removed value;
            // REVERSE / REORDER / CLEAR report as "pure" (negative index).
            (rec as ArrayLog).forEach((op, a, b) => {
                switch (op) {
                    case ARRAY_OP.PUSH: for (let k = 0; k < a; k++) cb(ctx, b + k, OPERATION.ADD); break;
                    case ARRAY_OP.INSERT: for (let k = 0; k < b; k++) cb(ctx, a + k, OPERATION.ADD); break;
                    case ARRAY_OP.RESTATE: for (let k = 0; k < a; k++) cb(ctx, k, OPERATION.ADD); break;
                    case ARRAY_OP.SET: cb(ctx, a, OPERATION.REPLACE); break;
                    case ARRAY_OP.REMOVE: for (let k = 0; k < b; k++) cb(ctx, a + k, OPERATION.DELETE); break;
                    default: cb(ctx, -op, op as any); break;
                }
            });
        } else {
            (rec as KeyedRecorder).forEach((index, op) => cb(ctx, index, op));
        }
    }

    size(): number {
        if (this._isSchema) return popcount32(this.dirtyLow) + popcount32(this.dirtyHigh);
        return this.rec?.size() ?? 0;
    }

    has(): boolean {
        if (this._isSchema) return (this.dirtyLow | this.dirtyHigh) !== 0;
        return this.rec !== undefined && this.rec.has();
    }

    reset(): void {
        if (this._isSchema) {
            this.dirtyLow = 0;
            this.dirtyHigh = 0;
            if (this.ops !== undefined) this.ops.fill(0);
            else { this.opsLow = 0; this.opsHigh = 0; }
            return;
        }
        this.rec?.reset();
    }

    /**
     * Full reset to construction defaults so the owning ref can be returned to
     * a pool and reused for a different logical entity (see encoder/Pool.ts +
     * Schema.reset). Unlike `reset()` / `endEncode()` (which only clear the
     * dirty bucket for the next encode), this also drops parent links, queue
     * nodes and per-view bitmaps, and re-arms IS_NEW.
     *
     * Precondition: the tree must already be detached from the encoder
     * (`root === undefined`) — i.e. the ref was removed from its parent
     * collection/field, which `Root.remove` does before this runs.
     */
    recycle(): void {
        if (this.root !== undefined) {
            throw new Error(
                `@colyseus/schema: cannot recycle an attached ChangeTree ` +
                `(${this.ref?.constructor?.name}). Remove the instance from its ` +
                `parent collection before releasing it to a pool.`
            );
        }

        // dirty/ops buckets (Schema: dirtyLow/High + ops; Collection: rec)
        if (this._isSchema) this.reset();
        else this.rec?.recycle();
        // keep the recorder object allocated (re-alloc is the cost we avoid), clear contents
        this.unreliableRecorder?.reset();

        // back to a freshly-constructed tree: IS_NEW, no inherited flags
        // (FILTERED/PATCH_ONLY/STATIC/STREAM are re-derived on the next setParent).
        // NEEDS_RESTAGE makes the next Root.add re-stage retained field values.
        this.flags = IS_NEW | NEEDS_RESTAGE;
        this._fullSyncGen = 0;

        // drop parent links — Root.remove clears `root` and the CHILDREN's
        // parent links, but leaves this tree's own parentRef dangling.
        this.parentRef = undefined;
        this._parentIndex = undefined;
        this.extraParents = undefined;

        // queue nodes (already nulled by Root.remove's queue removal; defensive)
        this.changesNode = undefined;
        this.unreliableChangesNode = undefined;

        this.paused = false;

        // per-view visibility lives on the tree (NOT keyed by refId), so a
        // recycled tree must not inherit its previous life's view membership.
        this.visibleViews = undefined;
        this.tagViews = undefined;
        this.subscribedViews = undefined;
    }

    /**
     * Re-stage the live contents as fresh ADDs on the matching channel.
     * Called by `Root.add` for a tree re-entering the encoder (refCount 0 →
     * 1, or a pooled instance with NEEDS_RESTAGE) and by the filtered→public
     * flip in `inheritedFlags.refreshFilterState`. Arrays re-state
     * positionally in one absorbing op (so clients that received elements by
     * identity get the server order and revision); an empty collection
     * records nothing, which keeps pooled instances byte-identical to fresh
     * ones.
     */
    restage(): void {
        if (this._isSchema) {
            _forEachLiveWithCtx(this, this, _restageSchemaCb);
            return;
        }
        const rec = this.rec;
        if (rec === undefined) return;
        if (this.encDescriptor.kind === KIND_ARRAY) {
            const arr = this.elements as any[];
            if (arr.length > 0) (rec as ArrayLog).restate(arrCopy(arr));
        } else {
            _forEachLiveWithCtx(this, rec as KeyedRecorder, _restageKeyedCb);
        }
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

    /** Enqueue this tree for the next reliable encode (collections call it after recording on `rec`). */
    touch(): void {
        this.root?.enqueueChangeTree(this);
    }

    /**
     * Route a Schema field mutation to the reliable or unreliable channel
     * and enqueue into the matching queue.
     *
     * `@unreliable` is decoration-time-validated to apply only to primitive
     * fields (see annotations.ts), so the per-field unreliable flag here
     * always means "primitive value updates" — the structural-ADD-routes-
     * reliable footgun for ref-type fields can't reach this code path.
     *
     * `!isNew` holds an `@unreliable` field on the RELIABLE channel until this
     * tree's own ADD has shipped there. A decoder can only apply a field write
     * to a ref it already knows, so a value emitted before the ADD is dropped —
     * permanently, if the field is never written again. `isNew` clears in
     * `endEncode()`, i.e. after a reliable pass, and recording reliably is
     * itself what enqueues the tree for that pass; the state is self-clearing
     * and no tree can be stranded on the wrong channel. Mirrors `encodeAll`,
     * which has always seeded these fields for late joiners.
     *
     * Ordering matters: `isFieldUnreliable` short-circuits on the class-level
     * `hasAnyUnreliable`, so schemas without the modifier never read `flags`.
     */
    change(index: number, operation: OPERATION = OPERATION.ADD) {
        if (this.paused || this.isFieldFullStateOnly(index)) return;
        if (this.isFieldUnreliable(index) && !this.isNew) {
            this.ensureUnreliableRecorder().record(index, operation);
            this.root?.enqueueUnreliable(this);
            return;
        }
        this.record(index, operation);
        this.root?.enqueueChangeTree(this);
    }

    /** Pending op at `index`: a Schema field op, or a keyed collection entry op (arrays have none). */
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

    // Reads via `refTarget` so ArraySchema's Proxy is bypassed.
    getValue(index: number, _isEncodeAll: boolean = false) {
        return this.refTarget[$getByIndex](index);
    }

    /** Schema field DELETE (collections record removals on their own recorder). */
    delete(index: number, operation?: OPERATION) {
        if (index === undefined) {
            try {
                throw new Error(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index '${index}'`);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        if (this.paused || this.isFieldFullStateOnly(index)) return this.getValue(index);

        // Same pre-ADD hold as `change` — a DELETE naming a ref the decoder
        // hasn't seen is dropped just like a field write.
        const unreliable = this.isFieldUnreliable(index) && !this.isNew;
        if (unreliable) this.ensureUnreliableRecorder().recordDelete(index, operation ?? OPERATION.DELETE);
        else this.recordDelete(index, operation ?? OPERATION.DELETE);

        const previousValue = this.getValue(index);

        // `this.root` is always undefined on decoder-side instances
        // (they're built via `initializeForDecoder`, which skips Root
        // attachment). The optional chain handles both sides; this is
        // an intentional invariant, not a bug.
        if (previousValue && previousValue[$changes]) this.root?.remove(previousValue[$changes]);

        if (unreliable) this.root?.enqueueUnreliable(this);
        else this.root?.enqueueChangeTree(this);

        return previousValue;
    }

    // Clear the reliable dirty bucket after a reliable encode pass. The
    // collection hook runs BEFORE the recorder reset: `MapSchema` purges
    // the index mappings of entries removed this tick from `rec.deleted`.
    endEncode() {
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.();
        this.reset();
        this.changesNode = undefined;
        this.isNew = false;
    }

    // Clear the unreliable dirty bucket after an unreliable encode pass.
    endEncodeUnreliable() {
        this.unreliableRecorder?.reset();
        this.unreliableChangesNode = undefined;
    }

    discard() {
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.();
        this.reset();
        this.unreliableRecorder?.reset();
    }

    // Recursively discard all changes on this + child structures. Tests only.
    discardAll() {
        this.forEachChild((child) => child.discardAll());
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
    /**
     * Index this tree holds in its primary parent. Stable for Schema fields
     * and keyed collections; informational only under an ArraySchema parent
     * (written at attach, not maintained across reorders — the encoder never
     * addresses array elements by slot).
     */
    get parentIndex(): number | undefined { return this._parentIndex; }

    addParent(parent: Ref, index: number): void { _addParent(this, parent, index); }

    /** @returns true if parent was found and removed */
    removeParent(parent: Ref = this.parent): boolean { return _removeParent(this, parent); }

    findParent(predicate: (parent: Ref, index: number) => boolean): ParentEntry | undefined {
        return _findParent(this, predicate);
    }

    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return _hasParent(this, predicate);
    }

    getAllParents(): ParentEntry[] { return _getAllParents(this); }

}

/**
 * Lightweight per-instance no-op ChangeTree used for instances the decoder
 * builds. Those instances never feed back into an Encoder, so the full
 * `ChangeTree` machinery (EncodeDescriptor lookup, recorder state, Maps /
 * Uint8Arrays for change slots) is pure overhead — this stub carries only a
 * `ref` back-pointer and no-op methods, so tree walkers and debug tooling
 * continue to work.
 *
 * Plug-in contract: each collection class and the `Decoder` pick between
 * `new ChangeTree(ref)` and `createUntrackedChangeTree(ref)` explicitly via
 * dedicated factories (`initializeForDecoder` on collections,
 * `createInstanceOfType` on the `Decoder`). There is no global state — every
 * decision is local to the call site.
 */
export class UntrackedChangeTree {
    ref: Ref;

    // Mirror the subset of ChangeTree state that decoder-path readers touch.
    // Everything else is deliberately undefined (matches the shape of a
    // freshly-constructed tree that never participated in a Root).
    root: undefined = undefined;
    parentRef: undefined = undefined;
    rec: undefined = undefined;
    paused: boolean = false;
    isNew: boolean = false;
    flags: number = 0;
    readonly tracking = false;
    readonly isArray = false;

    constructor(ref: Ref) {
        this.ref = ref;
    }

    // Mutation surface — all no-ops.
    change(): void {}
    delete(): void {}
    touch(): void {}
    restage(): void {}
    setParent(): void {}
    addParent(): void {}
    removeParent(): boolean { return false; }
    getChange(): number { return 0; }
    discard(): void {}
    discardAll(): void {}
    pause(): void {}
    resume(): void {}
    untracked<T>(fn: () => T): T { return fn(); }
    markDirty(): void {}

    // Tree-walk surface. Mirrors `treeAttachment.forEachChild` so debug tools
    // can still descend from a tracked root into decoder-built subtrees and
    // read each child's `$changes` (which is itself an UntrackedChangeTree
    // carrying the right `ref`).
    forEachChild(callback: (change: any, at: any) => void): void {
        const ref = this.ref as any;
        const ctor = ref.constructor as any;
        const kind = ctor?.COLLECTION_KIND;
        if (kind !== undefined) {
            if (typeof ref[$childType] !== "string") {
                if (kind === KIND_ARRAY) {
                    for (let i = 0, len = ref.length; i < len; i++) {
                        const value = ref[i];
                        if (!value) continue;
                        callback(value[$changes], i);
                    }
                } else if (kind === KIND_MAP) {
                    for (const [key, value] of ref.$items as Map<any, any>) {
                        if (!value) continue;
                        callback(value[$changes], ref.indexByKey.get(key));
                    }
                } else {
                    for (const [index, value] of ref.$items as Map<number, any>) {
                        if (!value) continue;
                        callback(value[$changes], index);
                    }
                }
            }
            return;
        }
        const metadata = ctor?.[Symbol.metadata];
        if (!metadata) return;
        const refFieldIndexes: number[] = metadata[$refTypeFieldIndexes] ?? [];
        for (let i = 0; i < refFieldIndexes.length; i++) {
            const index = refFieldIndexes[i];
            const value = ref[metadata[index].name];
            if (!value) continue;
            callback(value[$changes], index);
        }
    }

    forEachChildWithCtx<C>(ctx: C, callback: (ctx: C, change: any, at: any) => void): void {
        this.forEachChild((change, at) => callback(ctx, change, at));
    }

    forEachLive(): void {}
    forEachLiveWithCtx(): void {}
    forEach(): void {}
}

// Factory, cast to ChangeTree so call sites that type `$changes` as
// `ChangeTree` accept it. The surface overlap above covers every read/write
// the decoder path reaches.
export function createUntrackedChangeTree(ref: Ref): ChangeTree {
    return new UntrackedChangeTree(ref) as unknown as ChangeTree;
}

/**
 * Install a non-enumerable `$changes: UntrackedChangeTree` on `target`.
 * Shared by `Schema.initializeForDecoder` and every collection's
 * `initializeForDecoder`.
 *
 * `enumerable: false` is load-bearing — tests use `deepStrictEqual` on
 * decoded instances and walking into `$changes` would recurse through
 * circular refs. Same descriptor shape as the tracked `Schema.initialize`
 * + collection ctors.
 */
export function installUntrackedChangeTree(target: object, publicRef: object = target): void {
    Object.defineProperty(target, $changes, {
        value: createUntrackedChangeTree(publicRef as Ref),
        enumerable: false,
        writable: true,
    });
}
