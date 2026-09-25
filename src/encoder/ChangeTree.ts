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
import { ARRAY_OP, KIND_ARRAY, KIND_MAP, OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $onEncodeEnd, $getByIndex, $proxyTarget, $refId, $refTypeFieldIndexes, $numFields, $values, type $deleteByIndex } from "../types/symbols.js";

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
import { arrCopy } from "../types/custom/arrayOps.js";

import {
    addParent as _addParent, removeParent as _removeParent,
    findParent as _findParent, hasParent as _hasParent,
    getAllParents as _getAllParents,
} from "./changeTree/parentChain.js";
import { forEachLive as _forEachLive, forEachLiveWithCtx as _forEachLiveWithCtx } from "./changeTree/liveIteration.js";
import {
    setRoot as _setRoot, setParent as _setParent, ensureTracked,
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

// ── `$changes` storage (Schema instances and every collection) ──────────
// A private field instead of a non-enumerable own property: just as invisible
// to `deepStrictEqual` / `util.inspect`, and written by a plain store instead
// of an `Object.defineProperty` call per instance. The return-override base
// lets one private name be stamped on ANY object, including
// `Object.create`-built decoder instances.
//
// ArraySchema: its public identity is a Proxy, whose private fields V8 keeps in
// a side dictionary (slow and memory-heavy), so only the RAW TARGET is stamped
// (measured: bench/v6-results.md § Construction and attach). A reader that can
// meet an array branches on `Array.isArray` (sees through the Proxy, a cheap
// intrinsic) and hops through
// `$proxyTarget` — an own data property, reachable through the Proxy.
class TreeStampTarget { constructor(target: object) { return target; } }
class LocalTreeStamp extends TreeStampTarget {
    #tree: any;
    constructor(target: object, tree: any) { super(target); this.#tree = tree; }
    /** Same-copy instances that are not a Proxy (throws otherwise): `this`-based hot paths of Schema / Map / Set / Stream, and an ArraySchema's raw target. */
    static of(target: any): ChangeTree { return target.#tree; }
    /**
     * Same load as `of`, as a SEPARATE function on purpose: inline-cache
     * feedback belongs to the function literal, and `of` is fed every shape in
     * the process by the setters and the encoder (megamorphic). The decoder
     * only ever sees decoder-built shapes; with its own feedback slot its
     * per-chunk read stays polymorphic, as its `ref[$changes]` site used to be.
     */
    static ofDecoded(target: any): ChangeTree {
        // No array branch: a decoder-built ArraySchema IS its raw target and is
        // stamped directly (the `$proxyTarget` hop is measurable per chunk). Only
        // an encoder-built Proxy reaching the decoder — the initial value of an
        // array field on the state handed to `new Decoder(state)` — takes the catch.
        try { return target.#tree; } catch { return LocalTreeStamp.ofAny(target)!; }
    }
    /** An array value: the ArraySchema Proxy, its raw target, or a decoder-built one (its own target). A plain array has no tree. */
    static ofArray(target: any): ChangeTree | undefined {
        const raw = target[$proxyTarget];
        return (raw !== undefined) ? raw.#tree : undefined;
    }
    /** Install or replace: the cold path behind the `[$changes]` setter and the public `Schema.initialize`. */
    static put(target: any, tree: any): void {
        if (Array.isArray(target)) { target = (target as any)[$proxyTarget] ?? target; } // always the raw target, never the Proxy
        if (#tree in target) { target.#tree = tree; }
        else { new LocalTreeStamp(target, tree); }
    }
    /** `undefined` on an object without the slot (a prototype, a plain object) — never falls back to the accessor, so the accessor can use it. */
    static peek(target: any): ChangeTree | undefined {
        if (Array.isArray(target)) { target = (target as any)[$proxyTarget] ?? target; }
        try { return target.#tree; } catch { return undefined; }
    }
    /**
     * Any OBJECT a user can hand us. No `#tree in target` brand check (too
     * slow for the encode loop). The private load throws on an object without the slot — a plain object,
     * or an instance of a library build that predates the shared stamper (its
     * tree is then on the `[$changes]` symbol) — so only that rare path pays.
     */
    static ofAny(target: any): ChangeTree | undefined {
        if (Array.isArray(target)) { return LocalTreeStamp.ofArray(target); }
        try { return target.#tree; } catch { return target[$changes]; }
    }
    /** `ofAny` for the per-view pass (StateView + the view branch of the encoder), on its own feedback — see `ofDecoded`. */
    static ofView(target: any): ChangeTree | undefined {
        if (Array.isArray(target)) { return LocalTreeStamp.ofArray(target); }
        try { return target.#tree; } catch { return target[$changes]; }
    }
}
// A private name belongs to ONE class evaluation. Bundlers that ship two copies
// of this library in a process (server + client builds side by side) would
// otherwise get two names, and every cross-copy read — a Decoder of copy B
// instantiates copy A's classes through A's own factory — would miss. So the
// first copy to load publishes its stamper and every later copy adopts it: one
// private name per process, the same guarantee `Symbol.for("$changes")` gave.
const SHARED_STAMP = Symbol.for("@colyseus/schema:TreeStamp");
const TreeStamp: typeof LocalTreeStamp = ((globalThis as any)[SHARED_STAMP] ??= LocalTreeStamp);
// Only identical builds may share the stamper and the per-constructor caches: warn once per differing copy.
const VERSION = "6.0.0-alpha.0"; // = package.json "version": synced by `npm version` (scripts/sync-version.mjs), checked by test/CrossCopy.test.ts
const loadedVersion = ((globalThis as any)[Symbol.for("@colyseus/schema:version")] ??= VERSION);
if (loadedVersion !== VERSION) {
    console.warn(`@colyseus/schema: versions ${loadedVersion} and ${VERSION} are loaded in one process; cross-copy interop needs identical builds.`);
}

/** Install `tree` on a freshly-built instance (throws if it already has one — see `setTree`). */
export function stampTree(target: object, tree: any): void { new TreeStamp(target, tree); }
/** The instance's tree, read as a data load (the `[$changes]` prototype accessor is slower on polymorphic sites). */
export const treeOf = TreeStamp.of;
/** `treeOf` for the decoder's hot loop — see `TreeStamp.ofDecoded`. */
export const treeOfDecoded = TreeStamp.ofDecoded;
/** `refIdOf` for decoder-side values (a primitive, or a ref this process built), on the decoder's own feedback. */
export function decodedRefIdOf(value: any): number | undefined {
    return (typeof value === "object" && value !== null) ? TreeStamp.ofDecoded(value).refId : undefined;
}
export const setTree = TreeStamp.put;
/** The instance's tree, or `undefined` on an object without the slot (cold paths; never the public accessor). */
export const peekTree = TreeStamp.peek;
/** The tree of any VALUE — `undefined` for primitives, null and plain objects. Drop-in for `value?.[$changes]`. */
export function refTreeOf(value: any): ChangeTree | undefined {
    return (typeof value === "object" && value !== null) ? TreeStamp.ofAny(value) : undefined;
}
/** `refTreeOf` for the per-view pass — see `TreeStamp.ofView`. */
export function viewTreeOf(value: any): ChangeTree | undefined {
    return (typeof value === "object" && value !== null) ? TreeStamp.ofView(value) : undefined;
}
/** The refId of any VALUE (`undefined` for non-refs and for refs never attached / decoded). Drop-in for `value?.[$refId]`. */
export function refIdOf(value: any): number | undefined {
    const tree = refTreeOf(value);
    return (tree !== undefined) ? tree.refId : undefined;
}

// `ref[$changes]` / `ref[$refId]` for everyone OUTSIDE this library's hot
// paths (user code, other packages, a second bundled copy reaching our
// instances through `Symbol.for`): prototype accessors over the private slot.
// Non-own, so `deepStrictEqual` / `util.inspect` never see them. Internal
// code reads with `treeOf` / `refTreeOf` / `refIdOf` / `tree.refId` instead
// (an accessor is slower per read on a polymorphic site).
const REF_ACCESSORS: PropertyDescriptorMap = {
    // Setter: installs `tree` as-is — ownership contract on `ChangeTree.values`.
    [$changes]: {
        get(this: any) { return TreeStamp.peek(this); },
        set(this: any, tree: ChangeTree) { TreeStamp.put(this, tree); },
        enumerable: false, configurable: true,
    },
    [$refId]: {
        get(this: any) { return TreeStamp.peek(this)?.refId; },
        set(this: any, value: number | undefined) { const tree = TreeStamp.peek(this); if (tree !== undefined) { tree.refId = value; } },
        enumerable: false, configurable: true,
    },
};
/** Install the `[$changes]` / `[$refId]` accessors on a class prototype (Schema, each collection, external classes via `Metadata.setFields`). */
export function defineRefAccessors(proto: object): void {
    Object.defineProperties(proto, REF_ACCESSORS);
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
    // `[$refId]` is a prototype accessor over `tree.refId` (see
    // `defineRefAccessors`), not an own property; internal code reads
    // `refIdOf(ref)` / `tree.refId`.
    [$refId]?: number;
    // `$getByIndex` / `$deleteByIndex` are required on every actual ref
    // the decoder / encoder ever touches (Schema + every collection
    // implements both). Keeping them non-optional lets hot-path call
    // sites skip the `(ref as any)` cast.
    [$getByIndex](index: number, isEncodeAll?: boolean): any;
    [$deleteByIndex](index: number): void;
}

export type Ref = Schema | ArraySchema | MapSchema<any, any> | CollectionSchema | SetSchema | StreamSchema;

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
// Mutations on the ref are NOT tracked while set. See pause/resume/untracked.
export const IS_PAUSED = 512;
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

/**
 * Per-tree state that only some trees ever use, behind ONE slot of the
 * ChangeTree (`aux`), allocated on the first write: instance sharing
 * (`extraParents`), the `@unreliable` channel and view subscriptions
 * (`subscribedViews`, only on subscribed collections), kept off the in-object
 * slots of every tree. Accessors on ChangeTree keep the field names for cold
 * readers and all writers; hot readers (attach / detach / discard / enqueue)
 * read `tree.aux?.x` directly, so no getter is inlined into `setParent` & co.
 * `visibleViews`, `tagBits` and `tagViews` stay in-object: a view encode reads
 * them per tree (measured: bench/v6-results.md § Construction allocations).
 */
class ChangeTreeAux {
    extraParents: ParentChain | undefined = undefined;
    unreliableRecorder: ChangeRecorder | undefined = undefined;
    unreliableChangesNode: ChangeTreeNode | undefined = undefined;
    subscribedViews: number[] | undefined = undefined;
}

export class ChangeTree<T extends Ref = any> implements ChangeRecorder {
    ref: T;

    /**
     * Wire identity, assigned by `Root.add` on first attach (`undefined`
     * until then, and again after `Schema.reset`). `ref[$refId]` is a
     * prototype accessor over this slot.
     */
    refId: number | undefined;

    /**
     * Non-Proxy target of `ref` for encoder hot-path reads. For
     * `ArraySchema`, `ref` is the Proxy users interact with (its `set` trap
     * tracks index writes); `refTarget` is the raw array underneath. For every
     * other type `refTarget === ref`. Consumers that need the user-facing
     * identity (debug output, callback parents) keep using `ref`. For an
     * array it is also the element storage the encoder indexes.
     */
    refTarget: T;

    /**
     * The Schema instance's `$values` backing array (`undefined` for
     * collections). Cached here so the generated field setters reach it
     * through one `this[$changes]` load — a setter closure is shared by
     * every class that declares that field shape, so each `this[...]`
     * access in it is megamorphic; the tree's own fields are not.
     *
     * Contract (the one place it is written down):
     * - Schema tree: `values === ref[$values]` for as long as the tree is
     *   installed. `$values` is created by this constructor (or, for a
     *   decoder-built instance, by `initializeForDecoder` before its stub
     *   caches it; the attach-time upgrade of that stub keeps it) and is
     *   only replaced together with the tree, by `Schema.initialize`'s
     *   fresh-tree branch. Collection tree: `undefined`.
     * - A tree belongs to the instance it was built for (`ref`). Installing
     *   a tree built for ANOTHER instance through the `[$changes]` setter is
     *   unsupported: its `values`, `ref` and parent edges keep pointing at
     *   the other instance.
     * - `Schema.initialize` keeps an own tracked tree (idempotent), and
     *   replaces anything else (no tree, a decoder stub, a foreign tree).
     * - Readers: the encoder (`enterFrame`, the encode loop) reads `values`
     *   unguarded — only Schema trees reach it; the attach walk
     *   (`forEachChildWithCtx`) keeps its `values !== undefined` guard (one
     *   compare) for trees built by another library copy.
     */
    values: any[] | undefined;

    /** True when `ref` is an ArraySchema. */
    get isArray(): boolean { return this.encDescriptor.kind === KIND_ARRAY; }

    /** The class's `Symbol.metadata`. Cold paths only: hot readers (`checkInheritedFlags`, `forEachChild*`, the view walk) read `encDescriptor.metadata` directly (an extra load and an inlining decision per call). */
    get metadata(): Metadata { return this.encDescriptor.metadata; }

    /**
     * Per-class cache of filter fn / isSchema / metadata / per-field arrays,
     * looked up once at construction. The encode loop reads
     * `tree.encDescriptor` and never touches `ref.constructor` again. See
     * EncodeDescriptor.ts.
     */
    encDescriptor: EncodeDescriptor;

    root?: Root;

    /**
     * Inline single parent (the common case), held as its ChangeTree. The attach
     * path, the filter classification and every StateView add / remove /
     * visibility check need the parent TREE; deriving it from the parent ref is a
     * megamorphic load each time (three per attached instance). The ref is one
     * monomorphic hop away (`parentRef` below), so it needs no slot of its own.
     */
    parentTree?: ChangeTree;
    _parentIndex?: number;

    /** Rarely-used state (see `ChangeTreeAux`); `undefined` on most trees. */
    aux: ChangeTreeAux | undefined;
    private ensureAux(): ChangeTreeAux { return this.aux ??= new ChangeTreeAux(); }

    /** Linked list for 2nd+ parents (rare: instance sharing). */
    get extraParents(): ParentChain | undefined { const aux = this.aux; return (aux !== undefined) ? aux.extraParents : undefined; }
    set extraParents(v: ParentChain | undefined) { const aux = this.aux; if (aux !== undefined) aux.extraParents = v; else if (v !== undefined) this.ensureAux().extraParents = v; }

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

    /** Lazy-allocated unreliable-channel recorder (rare — opt-in via @unreliable). Lives on `aux`. */
    get unreliableRecorder(): ChangeRecorder | undefined { const aux = this.aux; return (aux !== undefined) ? aux.unreliableRecorder : undefined; }
    set unreliableRecorder(v: ChangeRecorder | undefined) { const aux = this.aux; if (aux !== undefined) aux.unreliableRecorder = v; else if (v !== undefined) this.ensureAux().unreliableRecorder = v; }

    /** When true, mutations on the ref are NOT tracked (`IS_PAUSED` flag bit). See pause/resume/untracked. */
    get paused(): boolean { return (this.flags & IS_PAUSED) !== 0; }
    set paused(v: boolean) { this.flags = v ? (this.flags | IS_PAUSED) : (this.flags & ~IS_PAUSED); }

    changesNode?: ChangeTreeNode;            // Root.changes linked-list node

    /** Root.unreliableChanges linked-list node. Lives on `aux`. */
    get unreliableChangesNode(): ChangeTreeNode | undefined { const aux = this.aux; return (aux !== undefined) ? aux.unreliableChangesNode : undefined; }
    set unreliableChangesNode(v: ChangeTreeNode | undefined) { const aux = this.aux; if (aux !== undefined) aux.unreliableChangesNode = v; else if (v !== undefined) this.ensureAux().unreliableChangesNode = v; }

    // Per-StateView visibility bitmaps. Bit `(viewId & 31)` in slot
    // `(viewId >> 5)` is set iff the view can see this tree. Lazy: undefined
    // until the tree participates in any view. In-object (not on `aux`): the
    // per-tree visibility check is the hottest read of a view encode.
    visibleViews?: number[];

    // Per-(view, tag) bitmaps. Custom tags only — DEFAULT_VIEW_TAG
    // visibility lives in `visibleViews`. Parallel arrays: `tagBits[j]` is
    // one power-of-two tag bit, `tagViews[j]` the `visibleViews`-shaped
    // bitmap of the views holding it on this tree. A tree carries one to a
    // few bits, so the hot readers (`StateView.hasTagOnTree`, `tagsOnTree`)
    // scan them linearly (cheaper than a `Map.get` per bit). In-object slots:
    // `hasTagOnTree` runs per field of a tagged tree on every view encode
    // (measured: bench/realworld-results.md § Round 2 — B).
    tagBits?: number[];
    tagViews?: number[][];

    /**
     * Per-view subscription bitmap — same layout as `visibleViews`. Set by
     * `StateView.subscribe(collection)` to mark the view as persistently
     * interested in this collection's contents. When a new child is
     * attached to a subscribed collection (setParent hook), it's
     * auto-propagated to every subscribed view (force-shipped for
     * Array/Map/Set/Collection; enqueued into per-view pending for
     * streams). Undefined until the first subscribe. Lives on `aux`: only
     * subscribed collections have one; the attach path reads the parent's
     * as `parentTree.aux?.subscribedViews`.
     */
    get subscribedViews(): number[] | undefined { const aux = this.aux; return (aux !== undefined) ? aux.subscribedViews : undefined; }
    set subscribedViews(v: number[] | undefined) { const aux = this.aux; if (aux !== undefined) aux.subscribedViews = v; else if (v !== undefined) this.ensureAux().subscribedViews = v; }

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
        return (this.flags & (IS_PAUSED | IS_FULL_STATE_ONLY)) === 0;
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
        // No tree-level `isUnreliable` check: @unreliable is rejected on
        // ref-type fields, so no tree carries the flag (see INHERITABLE_FLAGS).
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
        this.refId = undefined;
        // Parent slots exist from construction: added later they are three shape
        // transitions per tree and land outside the object.
        this.parentTree = undefined;
        this._parentIndex = undefined;
        this.aux = undefined;
        // Raw (non-Proxy) target, passed explicitly by ArraySchema's ctor —
        // the only proxied type. Defaulting to `ref` for everything else
        // skips a guaranteed-miss megamorphic `$proxyTarget` probe per
        // construction.
        this.refTarget = refTarget;

        this.values = undefined; // filled below, once the class descriptor is known (slot kept here: one field order for every tree)

        // Single per-class lookup that subsumes Symbol.metadata,
        // isValidInstance, $filter, the recorder factory and the bitmasks.
        // After this, the encode loop never touches `ref.constructor`.
        const desc = getEncodeDescriptor(ref);
        this.encDescriptor = desc;
        if (desc.isSchema) {
            // The instance's `$values` array, created HERE: exact size and packed
            // (see `EncodeDescriptor.valuesTemplate`). A decoder-built instance
            // being upgraded (`ensureTracked`) already has one.
            let values: any[] | undefined = (refTarget as any)[$values];
            if (values === undefined) { values = (refTarget as any)[$values] = desc.valuesTemplate.slice(); }
            this.values = values;
        }

        const isSchema = desc.isSchema;
        this._isSchema = isSchema;

        // Assign every optional slot so Schema and Collection trees share
        // one hidden-class transition path. The published build emits native
        // class fields (all slots defined, in declaration order, before this
        // body runs); the test build uses useDefineForClassFields=false, where
        // an uninitialized field is absent until assigned — these stores keep
        // both on one shape.
        this.ops = undefined;
        this.rec = undefined;
        this.visibleViews = undefined;
        this.tagBits = undefined;
        this.tagViews = undefined;

        if (isSchema) {
            const numFields = (desc.metadata?.[$numFields] ?? 0) as number;
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

        // back to a freshly-constructed tree: IS_NEW, no inherited flags
        // (FILTERED/PATCH_ONLY/STATIC/STREAM are re-derived on the next setParent),
        // not paused. NEEDS_RESTAGE makes the next Root.add re-stage retained field values.
        this.flags = IS_NEW | NEEDS_RESTAGE;
        this._fullSyncGen = 0;
        // drop the wire identity: a reused instance re-enters under a fresh refId
        this.refId = undefined;

        // drop parent links — Root.remove clears `root` and the CHILDREN's
        // parent links, but leaves this tree's own parentRef dangling.
        this.parentTree = undefined;
        this._parentIndex = undefined;

        // queue node (already nulled by Root.remove's queue removal; defensive)
        this.changesNode = undefined;

        // per-view visibility lives on the tree (NOT keyed by refId), so a
        // recycled tree must not inherit its previous life's view membership.
        this.visibleViews = undefined;
        this.tagBits = undefined;
        this.tagViews = undefined;

        // the rare state: parent chain, unreliable recorder + queue node, subscriptions.
        // The side object and its recorder stay allocated (re-alloc is the cost we avoid).
        const aux = this.aux;
        if (aux !== undefined) {
            aux.extraParents = undefined;
            aux.unreliableRecorder?.reset();
            aux.unreliableChangesNode = undefined;
            aux.subscribedViews = undefined;
        }
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
            const arr = this.refTarget as any[];
            if (arr.length > 0) (rec as ArrayLog).restate(arrCopy(arr));
        } else {
            _forEachLiveWithCtx(this, rec as KeyedRecorder, _restageKeyedCb);
        }
    }

    // Tree attachment + child iteration — see ./changeTree/treeAttachment.ts.
    setRoot(root: Root): void { _setRoot(this, root); }
    /** `parentTree`: the parent's ChangeTree when the caller has it (it always does internally) — saves deriving it from `parent`. */
    setParent(parent: Ref, root?: Root, parentIndex?: number, parentTree?: ChangeTree): void { _setParent(this, parent, root, parentIndex, parentTree); }
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
        if ((this.flags & IS_PAUSED) !== 0 || this.isFieldFullStateOnly(index)) return;
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

        if ((this.flags & IS_PAUSED) !== 0 || this.isFieldFullStateOnly(index)) return this.getValue(index);

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
        const previousTree = refTreeOf(previousValue);
        if (previousTree !== undefined) this.root?.remove(previousTree);

        if (unreliable) this.root?.enqueueUnreliable(this);
        else this.root?.enqueueChangeTree(this);

        return previousValue;
    }

    // Clear the reliable dirty bucket after a reliable encode pass. The
    // collection hook runs BEFORE the recorder reset: `MapSchema` purges
    // the index mappings of entries removed this tick from `rec.deleted`;
    // `shipped` says whether their DELETEs were encoded (false for `discard`).
    endEncode() {
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.(true);
        this.reset();
        this.changesNode = undefined;
        this.isNew = false;
    }

    // Clear the unreliable dirty bucket after an unreliable encode pass.
    endEncodeUnreliable() {
        this.aux?.unreliableRecorder?.reset();
        this.unreliableChangesNode = undefined;
    }

    discard() {
        if (!this._isSchema) (this.refTarget as any)[$onEncodeEnd]?.(false);
        this.reset();
        this.aux?.unreliableRecorder?.reset();
    }

    // Recursively discard all changes on this + child structures. Tests only.
    discardAll() {
        this.forEachChild((child) => child.discardAll());
        this.discard();
    }

    get changed() {
        return this.has() || (this.aux?.unreliableRecorder?.has() ?? false);
    }

    // ────────────────────────────────────────────────────────────────────
    // Parent chain — implementations in ./changeTree/parentChain.ts.
    // ────────────────────────────────────────────────────────────────────

    /** Immediate parent (primary). See `extraParents` for the 2nd+ chain. */
    get parent(): Ref | undefined { return this.parentRef; }
    /** The primary parent's public identity (for an ArraySchema: its Proxy). */
    get parentRef(): Ref | undefined {
        const parentTree = this.parentTree;
        return (parentTree !== undefined) ? parentTree.ref : undefined;
    }
    /**
     * Index this tree holds in its primary parent. Stable for Schema fields
     * and keyed collections; informational only under an ArraySchema parent
     * (written at attach, not maintained across reorders — the encoder never
     * addresses array elements by slot).
     */
    get parentIndex(): number | undefined { return this._parentIndex; }

    addParent(parent: Ref, index: number, parentTree?: ChangeTree): void { _addParent(this, parent, index, parentTree); }

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
 * builds. Those instances only reach an Encoder through a hand-off, which
 * replaces the stub (`treeAttachment.ensureTracked`), so the full
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
    /** Wire identity, assigned by `ReferenceTracker.addRef` (see ChangeTree.refId). */
    refId: number | undefined = undefined;

    // Mirror the subset of ChangeTree state that decoder-path readers touch.
    // Everything else is deliberately undefined (matches the shape of a
    // freshly-constructed tree that never participated in a Root).
    root: undefined = undefined;
    parentRef: undefined = undefined;
    rec: undefined = undefined;
    /**
     * Decoder-side per-ref record (`DecodeOperation.refInfoOf`): kind, the
     * class's DecodeInfo and the `$values` array for Schemas, the child /
     * key readers for collections. Lives here so one `ref[$changes]` load
     * replaces four megamorphic loads per decoded chunk. Only decoder-built
     * instances carry the slot: a tracked `ChangeTree` has no decoder
     * business, so the rare Decoder that decodes into a normally-constructed
     * instance (the root passed to `new Decoder(state)`) adds the property
     * to that one tree lazily instead of costing every server-side tree a field.
     */
    decodeInfo: unknown = undefined;
    paused: boolean = false;
    isNew: boolean = false;
    flags: number = 0;
    readonly tracking = false;
    readonly isArray = false;
    /**
     * Positive stub test: `false` only here (prototype getter, no instance
     * slot). Any other tree — a `ChangeTree`, or one from another library
     * copy without the getter — reads as tracked. Test `isTracked === false`.
     */
    get isTracked(): false { return false; }
    /** The instance's `$values` array (see ChangeTree.values); `undefined` for collections. */
    values: any[] | undefined;

    constructor(ref: Ref) {
        this.ref = ref;
        this.values = (ref as any)[$values];
    }

    // Mutation surface — all no-ops.
    change(): void {}
    delete(): void {}
    touch(): void {}
    restage(): void {}
    /** Attached to an encoder's tree (a graft of a decoded instance): upgrade and attach. The decoder passes no `root`. */
    setParent(parent: Ref, root?: Root, parentIndex?: number, parentTree?: ChangeTree): void {
        if (root !== undefined) ensureTracked(this as any).setParent(parent, root, parentIndex, parentTree);
    }
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
                        callback(refTreeOf(value)!, i);
                    }
                } else if (kind === KIND_MAP) {
                    for (const [key, value] of ref.$items as Map<any, any>) {
                        if (!value) continue;
                        callback(refTreeOf(value)!, ref.indexByKey.get(key));
                    }
                } else {
                    for (const [index, value] of ref.$items as Map<number, any>) {
                        if (!value) continue;
                        callback(refTreeOf(value)!, index);
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
            callback(refTreeOf(value)!, index);
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

/** Stamp a fresh `UntrackedChangeTree` on a decoder-built instance (every `initializeForDecoder`). */
export function installUntrackedChangeTree(target: object): void {
    setTree(target, createUntrackedChangeTree(target as Ref));
}
