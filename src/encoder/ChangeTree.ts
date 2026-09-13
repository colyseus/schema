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
 *   - inheritedFlags.ts  filter / unreliable / patchOnly / static inheritance
 *   - treeAttachment.ts  setRoot / setParent / forEachChild(+WithCtx)
 *
 * Public surface on ChangeTree is unchanged — methods are thin pass-throughs
 * into the helpers. V8 inlines the pass-throughs; the runtime shape stays
 * a single class to preserve hidden-class + IC behavior.
 */
import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refId, $refTypeFieldIndexes, $numFields, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";
import type { StreamSchema } from "../types/custom/StreamSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import { type ChangeRecorder, SchemaChangeRecorder, CollectionChangeRecorder, popcount32 } from "./ChangeRecorder.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import { type EncodeDescriptor, getEncodeDescriptor } from "./EncodeDescriptor.js";
import type { DecodeOperation } from "../decoder/DecodeOperation.js";

import {
    addParent as _addParent, removeParent as _removeParent,
    setParentIndex as _setParentIndex,
    findParent as _findParent, hasParent as _hasParent,
    getAllParents as _getAllParents,
    indexInParent as _indexInParent,
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
 * way to move a parent's index — `setParentIndex` does that.
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
// A full sync emitted this collection's live indexes while it still held
// pending ops. Those ops' wire indexes are now load-bearing — a client holds
// the elements at exactly those positions — so a same-tick ADD+DELETE must
// not be cancelled by `removeAt` (which shifts later slots down and would
// make the decoder splice-insert at an occupied index). Armed in
// `Encoder._fullSyncWalk`, cleared by `reset()`. Fail-safe: a stale bit costs
// one tick of the optimization, never a wrong byte.
export const PENDING_SHIPPED_BY_FULL_SYNC = 512;
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

export class ChangeTree<T extends Ref = any> implements ChangeRecorder {
    ref: T;

    /**
     * Non-Proxy target of `ref` for encoder hot-path reads. For
     * `ArraySchema`, `ref` is the Proxy users interact with; every property
     * access on it runs through the `get` trap (even for symbol keys, which
     * fall through to `Reflect.get` — one extra hop per lookup). The encoder
     * loop reads `[$getByIndex]`, `[$childType]`, `.items`, `.tmpItems` at
     * high frequency during `encode()` / `encodeAll()`; going through
     * `refTarget` skips all of those traps.
     *
     * For non-proxied types (Schema, MapSchema, SetSchema, CollectionSchema,
     * StreamSchema), `refTarget === ref`. Consumers that need the user-
     * facing identity (debug output, callback parents) keep using `ref`.
     */
    refTarget: T;

    /**
     * True when `ref` is an ArraySchema — the only proxied type, so its
     * user-facing identity differs from `refTarget`. Canonical predicate for
     * "is this tree's ref an array" without probing `ref` (which would hit
     * the Proxy trap) — two monomorphic loads on the tree itself.
     */
    get isArray(): boolean { return this.refTarget !== this.ref; }

    metadata: Metadata;

    /**
     * Per-class cache of encoder fn / filter fn / isSchema / metadata /
     * per-field arrays, looked up once at construction. The encode loop reads
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
     * Per-walk visit stamp written by `Encoder.encodeFullSync`'s DFS. A
     * tree is considered "already visited by the current walk" iff
     * `tree._fullSyncGen === ctx.gen` — the encoder bumps its generation
     * counter once per walk, then stamps each tree with that value on
     * first visit; any later encounter of the same tree (shared refs
     * reachable through multiple parents) short-circuits on the equality
     * check instead of recursing again.
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

    ensureUnreliableRecorder(): ChangeRecorder {
        if (this.unreliableRecorder === undefined) {
            this.unreliableRecorder = this._isSchema
                ? new SchemaChangeRecorder((this.metadata?.[$numFields] ?? 0) as number)
                : new CollectionChangeRecorder();
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
        // construction. Cached so hot-path reads skip the Proxy `get` trap.
        this.refTarget = refTarget;

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
        } else {
            const dirty = this.collDirty!;
            const prev = dirty.get(index);
            let finalOp: OPERATION;
            if (prev === undefined) finalOp = op;
            else if (prev === OPERATION.DELETE) finalOp = OPERATION.DELETE_AND_ADD;
            else if (prev === OPERATION.ADD && op === OPERATION.DELETE_AND_ADD) finalOp = OPERATION.DELETE_AND_ADD;
            else finalOp = prev;
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
        this.flags &= ~PENDING_SHIPPED_BY_FULL_SYNC;
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

        // dirty/ops buckets (Schema: dirtyLow/High + ops; Collection: collDirty/collPureOps)
        this.reset();
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
     * ArraySchema insert (unshift / splice with more inserts than deletes):
     * re-key pending ops at or above `at` by `+count`, then record ADDs for
     * the new items at indexes `at..at+count-1`.
     *
     * The rebuilt map's insertion order IS the wire order:
     *   1. ops below `at` — the insert doesn't move them, and an insert of
     *      their own must still be applied before this one (ascending);
     *   2. the new ADDs, ascending — the decoder splice-inserts each one,
     *      which only works lowest-index-first;
     *   3. the re-keyed ops, in their original relative order — their
     *      indexes now address the post-insert layout.
     * See ArraySchema#$setAt.
     */
    insertAt(at: number, count: number): void {
        if (this._isSchema) throw new Error("ChangeTree (Schema): insertAt is not supported");
        const src = this.collDirty!;
        const dst = new Map<number, OPERATION>();
        const track = !this.paused && !this.isFullStateOnly;
        if (at > 0) {
            for (const [idx, val] of src) if (idx < at) dst.set(idx, val);
        }
        if (track) {
            for (let i = 0; i < count; i++) dst.set(at + i, OPERATION.ADD);
        }
        for (const [idx, val] of src) if (idx >= at) dst.set(idx + count, val);
        this.collDirty = dst;
        // no unreliable re-key — collection trees never carry an unreliable
        // recorder (tree-level @unreliable is disabled, see isFieldUnreliable)
        if (track) this.root?.enqueueChangeTree(this);
    }

    /**
     * Inverse of `insertAt`: the wire slots in `[at, at+count)` never existed.
     * Drop their pending ops and re-key everything above them down by `count`,
     * preserving relative order exactly as `insertAt` does for the entries it
     * shifts up.
     *
     * Reached only through `ArraySchema.$cancelAdd`, after `ChangeTree.delete`
     * has already enqueued this tree and released the element's refCount — so
     * no enqueue here, and no `paused`/`isFullStateOnly` handling: neither can
     * have put an ADD in `collDirty` (`_routeAndRecord` returns early), and
     * the caller only cancels a pending ADD. `collPureOps` is left alone for
     * the same reason `insertAt` leaves it: a CLEAR/REVERSE resets the bucket
     * first (`ArraySchema.clear` → `discard()`).
     */
    removeAt(at: number, count: number): void {
        if (this._isSchema) throw new Error("ChangeTree (Schema): removeAt is not supported");
        const src = this.collDirty!;
        const end = at + count;

        // Tail cancel (the common case): nothing addresses a slot above the
        // removed range, so delete in place — no Map rebuild, no allocation.
        let needsShift = false;
        for (const idx of src.keys()) { if (idx >= end) { needsShift = true; break; } }
        if (!needsShift) {
            for (let i = at; i < end; i++) src.delete(i);
            return;
        }

        const dst = new Map<number, OPERATION>();
        for (const [idx, val] of src) {
            if (idx < at) dst.set(idx, val);
            else if (idx >= end) dst.set(idx - count, val);
        }
        this.collDirty = dst;
    }

    /** ArraySchema#unshift(): insert `count` items at the head. */
    unshift(count: number): void {
        this.insertAt(0, count);
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
        if (this.paused || this.isFullStateOnly) return;
        // Pure ops (CLEAR/REVERSE) only emit from collection trees — the
        // recorder here is always a CollectionChangeRecorder by construction.
        //
        // Tree-level `isUnreliable` is disabled (see INHERITABLE_FLAGS):
        // no collection tree can be marked unreliable as a whole under the
        // ref-field rejection rule in `Metadata.setUnreliable`. The branch
        // is kept as a comment for re-enablement.
        // if (this.isUnreliable) {
        //     (this.ensureUnreliableRecorder() as ICollectionChangeRecorder).recordPure(op);
        //     this.root?.enqueueUnreliable(this);
        // } else {
            this.recordPure(op);
            this.root?.enqueueChangeTree(this);
        // }
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
    private _routeAndRecord(index: number, op: OPERATION, raw: boolean): void {
        if (this.paused || this.isFieldFullStateOnly(index)) return;
        if (this.isFieldUnreliable(index) && !this.isNew) {
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
    // Reads via `refTarget` so ArraySchema's Proxy trap is bypassed on the
    // hot per-field encode path.
    getValue(index: number, isEncodeAll: boolean = false) {
        return this.refTarget[$getByIndex](index, isEncodeAll);
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

        if (this.paused || this.isFieldFullStateOnly(index)) return this.getValue(index);

        // Same pre-ADD hold as `_routeAndRecord` — a DELETE naming a ref the
        // decoder hasn't seen is dropped just like a field write.
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

    // Clear the reliable dirty bucket after a reliable encode pass.
    endEncode() {
        this.reset();
        this.changesNode = undefined;
        // Every collection class defines [$onEncodeEnd]; Schema never does —
        // probing it was a guaranteed megamorphic miss per drained tree.
        // `?.` stays: a FIELDLESS Schema has no metadata, so its tree is
        // `_isSchema === false` too. refTarget receiver skips ArraySchema's
        // proxy hops.
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.();
        this.isNew = false;
    }

    // Clear the unreliable dirty bucket after an unreliable encode pass.
    endEncodeUnreliable() {
        this.unreliableRecorder?.reset();
        this.unreliableChangesNode = undefined;
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.();
    }

    discard() {
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.();
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

    /** Re-point an existing parent's cached index after the parent reindexed. */
    setParentIndex(parent: Ref, index: number): void { _setParentIndex(this, parent, index); }

    /** @returns true if parent was found and removed */
    removeParent(parent: Ref = this.parent): boolean { return _removeParent(this, parent); }

    findParent(predicate: (parent: Ref, index: number) => boolean): ParentEntry | undefined {
        return _findParent(this, predicate);
    }

    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return _hasParent(this, predicate);
    }

    /** Wire index this tree holds inside `parent`, or undefined if not a parent. */
    indexInParent(parent: Ref): number | undefined { return _indexInParent(this, parent); }

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
    paused: boolean = false;
    isNew: boolean = false;
    flags: number = 0;

    constructor(ref: Ref) {
        this.ref = ref;
    }

    // Mutation surface — all no-ops.
    change(): void {}
    delete(): void {}
    indexedOperation(): void {}
    operation(): void {}
    setParent(): void {}
    addParent(): void {}
    setParentIndex(): void {}
    removeParent(): boolean { return false; }
    getChange(): number { return 0; }
    discard(): void {}
    discardAll(): void {}
    pause(): void {}
    resume(): void {}
    untracked<T>(fn: () => T): T { return fn(); }
    markDirty(): void {}

    // Tree-walk surface. Mirrors `treeAttachment.forEachChild` so debug tools
    // and `ArraySchema.clear()` can still descend from a tracked root into
    // decoder-built subtrees and read each child's `$changes` (which is
    // itself an UntrackedChangeTree carrying the right `ref`).
    forEachChild(callback: (change: any, at: any) => void): void {
        const ref = this.ref as any;
        if (ref[$childType]) {
            if (typeof ref[$childType] !== "string") {
                for (const [key, value] of ref.entries()) {
                    if (!value) continue;
                    callback(value[$changes], ref._collectionIndexes?.[key] ?? key);
                }
            }
            return;
        }
        const ctor = ref.constructor as any;
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
 * `initializeForDecoder`. `publicRef` defaults to `target` — pass a Proxy
 * instead (ArraySchema) so children attached to this tree see the Proxy
 * as their parent, not the raw target.
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
