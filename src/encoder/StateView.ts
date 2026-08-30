import { ChangeTree, Ref } from "./ChangeTree.js";
import { $changes, $childType, $fieldIndexesByViewTag, $refId, $viewFieldIndexes } from "../types/symbols.js";
import { DEFAULT_VIEW_TAG } from "../annotations.js";
import { OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { spliceOne } from "../types/utils.js";
import { ensureStreamState, streamDequeueForView, streamEnqueueForView } from "./streaming.js";
import type { StreamSchema } from "../types/custom/StreamSchema.js";
import type { MapSchema } from "../types/custom/MapSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { Schema } from "../Schema.js";
import type { Root, Streamable } from "./Root.js";

export function createView(iterable: boolean = false) {
    return new StateView(iterable);
}

/**
 * Clear the bit for `(slot, bit)` on every ChangeTree in `root`. Called
 * from `dispose()` and from the FinalizationRegistry callback so a view's
 * leftover visibility bits don't leak to whoever next acquires its ID.
 *
 * Cost: O(N trees) per dispose. dispose is rare (once per view lifecycle,
 * typically once per client disconnect), so the per-tick encode hot path
 * is unaffected.
 */
function _clearViewBitFromAllTrees(root: Root, slot: number, bit: number): void {
    const clearMask = ~bit;
    const trees = root.changeTrees;
    for (const refId in trees) {
        const tree = trees[refId];
        const v = tree.visibleViews;
        if (v !== undefined && slot < v.length) v[slot] &= clearMask;
        const s = tree.subscribedViews;
        if (s !== undefined && slot < s.length) s[slot] &= clearMask;
        const t = tree.tagViews;
        if (t !== undefined) {
            t.forEach((bitmap) => {
                if (slot < bitmap.length) bitmap[slot] &= clearMask;
            });
        }
    }
}

/**
 * `FinalizationRegistry` returns a view's ID to its Root's freelist AND
 * clears the view's leftover bits from every ChangeTree. Backstop for
 * forgotten `view.dispose()` calls; timing is non-deterministic but bounded.
 */
const _disposeRegistry = new FinalizationRegistry<{ root: Root; id: number; slot: number; bit: number }>(
    ({ root, id, slot, bit }) => {
        _clearViewBitFromAllTrees(root, slot, bit);
        root.releaseViewId(id);
    },
);

/**
 * Compact description of a rejected argument, for warning messages.
 * Passing the value itself to `console.warn` is not an option — a
 * populated collection inspects into dozens of lines of encoder
 * internals and buries the message that matters.
 */
/**
 * Sentinel inner-map key: "snapshot every live element of this ref-typed
 * ArraySchema". Written by `_add`'s bulk path instead of one entry per
 * element; `encodeView` expands it structurally at drain time, so the
 * emitted slots reflect any reindex that happened after `view.add()` —
 * and a whole-array snapshot costs one Map insert instead of N.
 * Real slots are never negative, so -1 cannot collide.
 */
export const ARRAY_SNAPSHOT = -1;

function describeArg(value: any): string {
    if (value === undefined) { return "undefined"; }
    if (value === null) { return "null"; }
    const type = typeof value;
    if (type === "string") {
        return JSON.stringify(value.length > 30 ? `${value.slice(0, 30)}…` : value);
    }
    if (type !== "object" && type !== "function") { return `${type} ${String(value)}`; }
    if (Array.isArray(value)) { return `Array(${value.length})`; }
    return value.constructor?.name ?? "Object";
}

export class StateView {
    /**
     * Iterable list of items that are visible to this view
     * (Available only if constructed with `iterable: true`)
     */
    items: Ref[];

    /**
     * Unique ID assigned by the Root that owns this view's encoder. Used
     * to address per-StateView visibility bits stored on each ChangeTree.
     * Lazily allocated on first `add()` because the StateView itself
     * doesn't know its Root until then.
     */
    id: number = -1;
    private _root?: Root;

    /** Cached `id >> 5` and `1 << (id & 31)` for the hot encode-loop check. */
    private _slot: number = 0;
    private _bit: number = 0;

    /**
     * Per-tree custom-tag membership lives on each ChangeTree's `tagViews`
     * map (keyed by tag, value is a per-view bitmap). The StateView only
     * needs its slot/bit pair to read/write it. Replaces the legacy
     * `tags: WeakMap<ChangeTree, Set<number>>` allocation per (view, tree).
     */

    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (Used to force encoding a property even if it was not changed.)
     *
     * Inner storage is a Map so the encode loop in `encodeView` can iterate
     * directly with numeric keys — the legacy `{[index]: OPERATION}` shape
     * forced an `Object.keys(...)` allocation + `Number(key)` parse per ref.
     *
     * Inner keys are numbers (Schema field indexes, MapSchema journal
     * indexes, Set/Collection indexes, stream positions — all stable within
     * a tick), EXCEPT element bindings under a ref-typed ArraySchema parent,
     * which are keyed by the child's ChangeTree. An array wire slot captured
     * at `view.add()` time goes stale if the array reindexes (unshift /
     * reverse / move) later in the same tick — identity keys let
     * `encodeView` resolve the CURRENT slot at drain time instead.
     */
    changes = new Map<number, Map<number | ChangeTree, OPERATION>>();

    constructor(public iterable: boolean = false) {
        if (iterable) {
            this.items = [];
        }
    }

    /**
     * Lazily bind this view to a Root and acquire a view ID. Called on
     * the first add() because StateView is constructed before its target
     * Root is known.
     */
    private _bindRoot(root: Root): void {
        if (this._root !== undefined) return;
        this._root = root;
        this.id = root.acquireViewId();
        this._slot = this.id >> 5;
        this._bit = 1 << (this.id & 31);
        root.registerView(this);
        _disposeRegistry.register(
            this,
            { root, id: this.id, slot: this._slot, bit: this._bit },
            this,
        );
    }

    /**
     * Release this view's ID back to the Root for reuse, AND clear all
     * visibility bits this view set on any ChangeTree. The clear is
     * essential — without it, a future view that acquires this same ID
     * would inherit our visibility state and see things it shouldn't
     * (privacy bug). Documented in StateViewInternals.test.ts.
     *
     * Optional API but strongly recommended on client-leave; otherwise
     * the FinalizationRegistry backstop runs at GC (non-deterministic).
     */
    public dispose(): void {
        if (this._root === undefined) return;
        this._root.unregisterView(this);
        _clearViewBitFromAllTrees(this._root, this._slot, this._bit);
        this._root.releaseViewId(this.id);
        _disposeRegistry.unregister(this);
        this._root = undefined;
        this.id = -1;
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-tree visibility bitmap helpers. Replace the old WeakSet ops
    // with O(1) bitwise ops on a chunked number[] stored on each tree.
    // ──────────────────────────────────────────────────────────────────

    /** True iff this view can see `tree`. */
    public isVisible(tree: ChangeTree): boolean {
        const arr = tree.visibleViews;
        const slot = this._slot;
        return arr !== undefined && slot < arr.length && (arr[slot] & this._bit) !== 0;
    }

    /** Mark `tree` as visible to this view. */
    public markVisible(tree: ChangeTree): void {
        const slot = this._slot;
        let arr = tree.visibleViews;
        if (arr === undefined) {
            arr = tree.visibleViews = [];
        }
        while (arr.length <= slot) arr.push(0);
        arr[slot] |= this._bit;
    }

    /** Clear visibility bit. */
    public unmarkVisible(tree: ChangeTree): void {
        const arr = tree.visibleViews;
        if (arr === undefined) return;
        const slot = this._slot;
        if (slot < arr.length) arr[slot] &= ~this._bit;
    }

    /** True iff this view is subscribed to `tree`. */
    public isSubscribed(tree: ChangeTree): boolean {
        const arr = tree.subscribedViews;
        const slot = this._slot;
        return arr !== undefined && slot < arr.length && (arr[slot] & this._bit) !== 0;
    }

    /** Set the subscription bit on `tree`. */
    private _setSubscribed(tree: ChangeTree): void {
        const slot = this._slot;
        let arr = tree.subscribedViews;
        if (arr === undefined) {
            arr = tree.subscribedViews = [];
        }
        while (arr.length <= slot) arr.push(0);
        arr[slot] |= this._bit;
    }

    /** Clear the subscription bit on `tree`. */
    private _clearSubscribed(tree: ChangeTree): void {
        const arr = tree.subscribedViews;
        if (arr === undefined) return;
        const slot = this._slot;
        if (slot < arr.length) arr[slot] &= ~this._bit;
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-tag, per-view bitmap. Replaces the legacy
    // `tags: WeakMap<ChangeTree, Set<number>>` storage. Hot read site is
    // `Schema.ts` filter check — `hasTagOnTree` is O(1) bitwise.
    // ──────────────────────────────────────────────────────────────────

    /**
     * True iff this view shares at least one tag bit with `tree`.
     *
     * `tagViews` is keyed by individual power-of-two bits (custom tags must
     * be powers of two; `@view(A|B)` field masks are decomposed on store).
     * A field whose mask is `tag` is visible if the view was `add()`ed with
     * any overlapping bit — so we walk `tag`'s set bits and return on the
     * first match. Passing DEFAULT_VIEW_TAG (-1, all bits) answers "does
     * this view hold ANY custom tag on the tree".
     */
    public hasTagOnTree(tree: ChangeTree, tag: number): boolean {
        const map = tree.tagViews;
        if (map === undefined) return false;
        const slot = this._slot;
        const bit = this._bit;
        for (let bits = tag; bits !== 0; bits &= bits - 1) {
            const arr = map.get(bits & -bits); // isolate lowest set bit
            if (arr !== undefined && slot < arr.length && (arr[slot] & bit) !== 0) return true;
        }
        return false;
    }

    /** Mark `tree` as carrying `tag` (each of its bits) for this view. */
    public addTag(tree: ChangeTree, tag: number): void {
        // DEFAULT_VIEW_TAG visibility lives in `visibleViews`, not here.
        if (tag === DEFAULT_VIEW_TAG) return;
        let map = tree.tagViews;
        if (map === undefined) {
            map = tree.tagViews = new Map();
        }
        const slot = this._slot;
        const bit = this._bit;
        for (let bits = tag; bits > 0; bits &= bits - 1) {
            const b = bits & -bits; // isolate lowest set bit
            let arr = map.get(b);
            if (arr === undefined) {
                arr = [];
                map.set(b, arr);
            }
            while (arr.length <= slot) arr.push(0);
            arr[slot] |= bit;
        }
    }

    /** Clear each of `tag`'s bits for this view on `tree`. */
    public removeTag(tree: ChangeTree, tag: number): void {
        if (tag === DEFAULT_VIEW_TAG) return;
        const map = tree.tagViews;
        if (map === undefined) return;
        const slot = this._slot;
        const clearMask = ~this._bit;
        for (let bits = tag; bits > 0; bits &= bits - 1) {
            const arr = map.get(bits & -bits);
            if (arr !== undefined && slot < arr.length) arr[slot] &= clearMask;
        }
    }

    /** Clear ALL tag bits this view holds on `tree` (used when the per-tag isn't known). */
    public removeAllTagsOnTree(tree: ChangeTree): void {
        const map = tree.tagViews;
        if (map === undefined) return;
        const slot = this._slot;
        const clearMask = ~this._bit;
        map.forEach((arr) => {
            if (slot < arr.length) arr[slot] &= clearMask;
        });
    }

    // TODO: allow to set multiple tags at once
    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG, checkIncludeParent: boolean = true) {
        return this._add(obj, tag, checkIncludeParent, /* _skipStreamRouting */ false);
    }

    /**
     * Internal: force-ship an object through `view.changes` without
     * applying stream-element routing. Called by `Encoder._emitStreamPriority`
     * when it's draining `_pendingByView` — the element is already out of
     * pending at that point, so re-routing back into pending would be a
     * loop. User code should always call `add()`.
     */
    _addImmediate(obj: Ref, tag: number = DEFAULT_VIEW_TAG): void {
        this._add(obj, tag, /* checkIncludeParent */ true, /* _skipStreamRouting */ true);
    }

    private _add(obj: Ref, tag: number, checkIncludeParent: boolean, _skipStreamRouting: boolean) {
        const changeTree: ChangeTree = obj?.[$changes];
        if (!changeTree) {
            console.warn(
                `StateView#add(): expected a Schema instance or collection, received ${describeArg(obj)}`,
            );
            return false;
        }

        const parentChangeTree = changeTree.parent;

        if (
            !parentChangeTree &&
            obj[$refId] !== 0 // allow root object
        ) {
            /**
             * Detached adds are refused: addParentOf() walks the parent
             * chain to propagate visibility upward, which requires a real
             * parent reference. A detached instance has neither a parent
             * ChangeTree nor a parentIndex, so we can't decide whether an
             * ancestor carries a @view tag that should bring the subtree
             * along. Users must assign the ref into the state tree before
             * calling view.add().
             */
            throw new Error(
                `Cannot add a detached instance to the StateView. Make sure to assign the "${changeTree.ref.constructor.name}" instance to the state before calling view.add()`
            );
        }

        // Bind to Root + acquire view ID on first add(). Until then, we have
        // no per-tree bit position to write into.
        if (this._root === undefined && changeTree.root !== undefined) {
            this._bindRoot(changeTree.root);
        }

        // Streamable-element routing: when `obj` is a child of a streamable
        // collection (StreamSchema element, or an entry in a .stream()
        // MapSchema), subscribe this element to the stream's per-view
        // pending. The element is NOT marked visible here — visibility is
        // flipped on by the encoder's priority pass (`_addImmediate`) when
        // it actually ships the element. This is load-bearing: if the
        // element were visible before the priority pass, `encodeAllView`
        // would full-sync-emit it on bootstrap and `encodeView`'s normal
        // pass would emit its dirty state — both bypass `maxPerTick`.
        //
        // StateView mode is imperative by design — users call
        // `view.add(entity)` per-entity as the game loop's AOI / interest
        // logic discovers visibility. This matches the rationale that led
        // to StateView in the first place: per-client visibility as a
        // game-loop-cadence operation, not an encode-time predicate.
        const parentStreamTree = parentChangeTree?.[$changes];
        if (!_skipStreamRouting && parentStreamTree?.isStreamCollection) {
            streamEnqueueForView(
                parentChangeTree as unknown as Streamable,
                this.id,
                changeTree.parentIndex!,
            );
            return true;
        }

        // Collection types (ArraySchema / MapSchema / etc.) have no
        // `Symbol.metadata` — `metadata` is undefined here and consumers
        // below use `metadata?.[...]` null-safe access. Only Schema
        // subclasses yield a real Metadata object.
        const metadata: Metadata = (obj.constructor as typeof Schema)[Symbol.metadata];

        const wasVisible = this.isVisible(changeTree);

        // Add to iterable list (only the explicitly added items), deduping
        // re-adds of an already-visible instance; indexOf runs only on the
        // re-add path.
        // NOTE: dedup applies to `items` only — a default-tag re-add still
        // re-queues the full snapshot on purpose (shared-view bootstrap
        // re-add: a late-attached client may not have consumed earlier
        // drains). Callers wanting cheap idempotence can guard with
        // `view.has(obj)`.
        if (this.iterable && checkIncludeParent
            && (!wasVisible || this.items.indexOf(obj) === -1)) {
            this.items.push(obj);
        }

        this.markVisible(changeTree);

        // add parent ChangeTree's
        // - if it was invisible to this view
        // - if it were previously filtered out
        if (checkIncludeParent && parentChangeTree) {
            this.addParentOf(changeTree, tag);
        }

        // Streamable-collection (the stream itself, not an element): mark
        // visible only. No auto-seed of elements — users must explicitly
        // `view.add(entity)` per element (see rationale above).
        if (!_skipStreamRouting && changeTree.isStreamCollection) {
            return true;
        }

        // Fast path: fresh (isNew) subtree added with default tag. The
        // shared encode pass walks the whole subtree and emits ADDs for
        // every field, so the view pass only needs visibility bits — no
        // `view.changes` entries are needed for this subtree itself.
        // `addParentOf` above already emitted the parent collection's
        // ADD. Skipping the full `_add` cascade avoids ~N empty Map
        // allocations per bootstrap where N = descendant count.
        //
        // Safe against the insertion-order invariant below because this
        // path performs no writes — there is no order to preserve.
        if (tag === DEFAULT_VIEW_TAG && changeTree.isNew) {
            this._markSubtreeVisible(changeTree, tag);
            return false;
        }

        // Insertion order here is load-bearing: the encoder drains
        // `view.changes` in Map iteration order, and the decoder needs the
        // parent's SWITCH_TO_STRUCTURE to register its refId before any
        // entries for nested refs arrive. `forEachChild` below recurses
        // into `this.add(child, ...)`, which inserts child refIds — if we
        // deferred this insert past that point, children would be emitted
        // first and the decoder would see "refId not found".
        let changes = this.changes.get(obj[$refId]);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(obj[$refId], changes);
        }

        let isChildAdded = false;

        //
        // Add children of this ChangeTree first.
        // If successful, we must link the current ChangeTree to the child.
        //
        // Read per-field tags from the class's precomputed `tags[]` array
        // rather than chasing `metadata[index].tag` — same source, but a
        // direct array index instead of a per-field-object hop.
        const tags = changeTree.encDescriptor.tags;
        changeTree.forEachChild((change, index) => {
            // Do not ADD children whose field tag shares no bit with `tag`.
            // DEFAULT_VIEW_TAG fields are visible to all clients; custom-tag
            // fields only when bits overlap, and never to default-tag clients.
            const fieldTag = tags[index];
            if (fieldTag !== undefined) {
                const tagMatch = fieldTag === DEFAULT_VIEW_TAG ||
                    (tag !== DEFAULT_VIEW_TAG && (fieldTag & tag) !== 0);
                if (!tagMatch) {
                    return;
                }
            }

            if (this.add(change.ref, tag, false)) {
                isChildAdded = true;
            }
        });

        // set tag
        if (tag !== DEFAULT_VIEW_TAG) {
            this.addTag(changeTree, tag);

            // Ref: add tagged properties. `$fieldIndexesByViewTag` is keyed
            // per-bit, so a combined add-tag (`view.add(obj, A|B)`) must look
            // up each set bit to force-ADD every field that shares a bit.
            const byTag = metadata?.[$fieldIndexesByViewTag];
            if (byTag !== undefined) {
                for (let bits = tag; bits > 0; bits &= bits - 1) {
                    byTag[bits & -bits]?.forEach((index) => {
                        if (changeTree.getChange(index) !== OPERATION.DELETE) {
                            changes.set(index, OPERATION.ADD);
                        }
                    });
                }
            }
        }

        // Full-sync snapshot of a non-new tree (fresh ones ship via .encode()).
        // Also runs for custom tags when bootstrapping the tree for this view
        // (!wasVisible) — the per-field filter admits untagged fields, and
        // collections behind tagged fields have no `byTag`: without the
        // snapshot their elements are never introduced ("refId" not found).
        // A tagged add on an already-visible tree stays incremental (byTag
        // only); default-tag re-adds re-snapshot on purpose (see `items`
        // dedup note above).
        if ((tag === DEFAULT_VIEW_TAG || !wasVisible) && (!changeTree.isNew || isChildAdded)) {
            if (changeTree.isArray && typeof (changeTree.refTarget as any)[$childType] !== "string") {
                // Ref-typed ArraySchema (the only proxied collection): one
                // sentinel entry — encodeView snapshots the live elements at
                // drain time, so the slots survive a same-tick reindex (see
                // `changes` field docs) and the write stays O(1).
                if ((changeTree.refTarget as any).items.length > 0) {
                    changes.set(ARRAY_SNAPSHOT, OPERATION.ADD);
                    isChildAdded = true;
                }

            } else {
                // Full-sync snapshot: walk the live ref structurally instead of
                // iterating a cumulative recorder bucket. Every populated index
                // is emitted as ADD (matching the op-coercion previously done
                // at encode time). Per-field tags come from the descriptor's
                // precomputed `tags[]` array — direct index vs a metadata[i].tag
                // object hop.
                //
                // Non-matching custom-tagged fields are NEVER included here —
                // `view.changes` is drained without a per-field tag re-check,
                // so anything added leaks straight to the wire.
                const tags = changeTree.encDescriptor.tags;
                changeTree.forEachLive((index) => {
                    const tagAtIndex = tags[index];
                    if (
                        tagAtIndex === undefined || // "all change" with no tag
                        tagAtIndex === DEFAULT_VIEW_TAG || // visible to all clients
                        (tag !== DEFAULT_VIEW_TAG && (tagAtIndex & tag) !== 0) // tag bits overlap
                    ) {
                        changes.set(index, OPERATION.ADD);
                        isChildAdded = true;
                    }
                });
            }
        }

        return isChildAdded;
    }

    /**
     * Walk an isNew subtree marking each descendant visible. Counterpart
     * to the `_add()` fast path: skips `view.changes` allocations because
     * the shared encode pass emits the whole fresh subtree structurally
     * — the view pass just needs visibility bits to let those emissions
     * through the per-tree filter.
     *
     * Preserves the `@view()`-tag filter from `_add`'s forEachChild: a
     * Schema descendant behind a non-matching field tag is skipped so
     * tagged fields don't leak into a default-tag view. Collections have
     * no per-field tags (`encDescriptor.tags` is empty), so the filter
     * is a no-op for collection children.
     *
     * If a descendant has `isNew=false` (rare: a detached sub-collection
     * was re-attached to a fresh parent), fall back to the full `_add`
     * path for that branch so its cumulative state is emitted correctly.
     */
    private _markSubtreeVisible(tree: ChangeTree, tag: number): void {
        const tags = tree.encDescriptor.tags;
        tree.forEachChild((child, index) => {
            const fieldTag = tags[index];
            if (fieldTag !== undefined) {
                const tagMatch = fieldTag === DEFAULT_VIEW_TAG ||
                    (tag !== DEFAULT_VIEW_TAG && (fieldTag & tag) !== 0);
                if (!tagMatch) return;
            }

            if (child.isNew) {
                this.markVisible(child);
                this._markSubtreeVisible(child, tag);
            } else {
                this._add(child.ref, tag, false, false);
            }
        });
    }

    protected addParentOf(childChangeTree: ChangeTree, tag: number) {
        const changeTree = childChangeTree.parent[$changes];
        const parentIndex = childChangeTree.parentIndex;

        if (!this.isVisible(changeTree)) {
            // view must have all "changeTree" parent tree
            this.markVisible(changeTree);
        }

        // Recurse all the way to the root REGARDLESS of whether this parent
        // is already visible. Walking the full chain keeps `view.changes`
        // topologically ordered by construction (ancestors touched before
        // the descendant's entry), and — crucially — re-queues the ancestor
        // binding ops every time: visibility bits are per-VIEW, but the ADD
        // ops they once queued are consumed per-ENCODE. With a shared view,
        // an earlier encode (for other clients) or a dropped backlog leaves
        // an already-visible ancestor whose binding a late-attached client
        // never received — its filtered-container refId would then arrive
        // unbound ("refId not found"). Re-writing the entry ops is cheap
        // (Map.set dedupes within a patch) and decodes as a no-op for
        // clients that already hold the refs. The entry-write below is
        // still gated on `hasFilteredFields` so non-filtered ancestors
        // don't emit redundant wire bytes (the decoder already knows them
        // via the shared encode pass).
        const parentChangeTree: ChangeTree = changeTree.parent?.[$changes];
        if (parentChangeTree) {
            this.addParentOf(changeTree, tag);
        }

        // Skip the entry-write for non-filtered ancestors: their refIds
        // are already known to the decoder through the shared pass, and
        // an extra ADD on a non-filtered field's index would only emit
        // bytes for a no-op (`value === previousValue` on the decoder).
        if (!changeTree.hasFilteredFields) return;

        // add parent's tag properties
        if (changeTree.getChange(parentIndex) !== OPERATION.DELETE) {
            let changes = this.changes.get(changeTree.ref[$refId]);
            if (changes === undefined) {
                changes = new Map<number | ChangeTree, OPERATION>();
                this.changes.set(changeTree.ref[$refId], changes);
            }

            // Grant the tag on the parent only when the field pointing at
            // the child carries an overlapping tag — that field is the sole
            // reason the parent needs it. Granting unconditionally handed
            // the view every OTHER same-tag field on the parent, which then
            // rode out on its next mutation (never at add() time, so it read
            // as "the field only shows up after it changes").
            const parentFieldTag = changeTree.encDescriptor.tags[parentIndex];
            if (parentFieldTag !== undefined &&
                parentFieldTag !== DEFAULT_VIEW_TAG &&
                (parentFieldTag & tag) !== 0) {
                this.addTag(changeTree, tag);
            }

            // ArraySchema parents: key by the child's identity, not the wire
            // slot it holds right now — a same-tick unshift()/reverse()/move()
            // would shift the slot before encodeView drains this entry. Other
            // parents keep numeric keys (Schema fields, MapSchema journal
            // indexes and Set/Collection indexes are stable within a tick).
            changes.set(
                changeTree.isArray ? childChangeTree : parentIndex,
                OPERATION.ADD,
            );
        }
    }

    /**
     * Walk `tree`'s parent chain to root and insert an empty entry into
     * `view.changes` for any ancestor not already present. Empty entries
     * are skipped by `encodeView` (`changes.size === 0` continue), so no
     * wire bytes are emitted — but the Map's insertion order now puts
     * each ancestor BEFORE the descendant entry that the caller is about
     * to write. Combined with `addParentOf`'s full-recursion walk on
     * `view.add`, this preserves the global invariant that
     * `view.changes` iteration order is topological.
     *
     * Iterative (not recursive) so the stack is bounded by tree depth
     * regardless of call patterns. Stops the walk as soon as it hits an
     * ancestor that's already in `view.changes` — at that point the
     * remainder of the chain is guaranteed to also be present (invariant
     * upheld by every prior caller).
     */
    private _touchAncestorsOf(tree: ChangeTree): void {
        let cursor = tree.parent?.[$changes] as ChangeTree | undefined;
        if (cursor === undefined) return;

        // Collect the missing prefix of the chain, deepest-first. Only
        // FILTERED ancestors need entries — non-filtered ones never
        // appear in `view.changes` (mirrors the addParentOf gate), so
        // they don't need a Map slot reserved either.
        const stack: ChangeTree[] = [];
        while (cursor !== undefined) {
            if (cursor.hasFilteredFields) {
                const refId = cursor.ref[$refId];
                if (this.changes.has(refId)) break;
                stack.push(cursor);
            }
            cursor = cursor.parent?.[$changes] as ChangeTree | undefined;
        }

        // Insert root-first so Map order is topological.
        for (let i = stack.length - 1; i >= 0; i--) {
            this.changes.set(stack[i].ref[$refId], new Map());
        }
    }

    remove(obj: Ref, tag?: number): this; // hide _isClear parameter from public API
    remove(obj: Ref, tag?: number, _isClear?: boolean): this;
    remove(obj: Ref, tag: number = DEFAULT_VIEW_TAG, _isClear: boolean = false): this {
        const changeTree: ChangeTree = obj?.[$changes];
        if (!changeTree) {
            console.warn(
                `StateView#remove(): expected a Schema instance or collection, received ${describeArg(obj)}`,
            );
            return this;
        }

        // ── Streamable-element unsubscribe ─────────────────────────────
        // Symmetric to the `add(streamElement)` routing: pull the element
        // out of the stream's per-view state. If it never made it to the
        // wire (still in pending), silent drop; if already sent, queue
        // DELETE via `view.changes` for the next encodeView drain.
        const parentTree = changeTree.parent?.[$changes];
        if (parentTree?.isStreamCollection) {
            this.unmarkVisible(changeTree);
            if (this.iterable && !_isClear) {
                spliceOne(this.items, this.items.indexOf(obj));
            }
            streamDequeueForView(
                changeTree.parent as unknown as Streamable,
                this.id,
                (changeTree.parent as any)[$refId],
                changeTree.parentIndex!,
                this.changes,
            );
            this._recursiveDeleteVisibleChangeTree(changeTree);
            return this;
        }

        // ── Streamable-collection unsubscribe (the stream itself) ─────
        // Flush DELETE for every sent position and drop pending. After
        // this, the stream is no longer visible to this view — any future
        // `stream.add()` would still seed broadcast pending (if no views)
        // but would NOT re-seed per-view pending (user must re-subscribe).
        if (changeTree.isStreamCollection) {
            this.unmarkVisible(changeTree);
            if (this.iterable && !_isClear) {
                spliceOne(this.items, this.items.indexOf(obj));
            }
            const streamRef: any = changeTree.ref;
            const st = streamRef._stream;
            if (st !== undefined) {
                st.pendingByView.get(this.id)?.clear();
                const sent = st.sentByView.get(this.id);
                if (sent !== undefined && sent.size > 0) {
                    const streamRefId = streamRef[$refId];
                    let changes = this.changes.get(streamRefId);
                    if (changes === undefined) {
                        changes = new Map();
                        this.changes.set(streamRefId, changes);
                    }
                    for (const pos of sent) changes.set(pos, OPERATION.DELETE);
                    sent.clear();
                }
            }
            return this;
        }

        this.unmarkVisible(changeTree);

        // remove from iterable list
        if (
            this.iterable &&
            !_isClear // no need to remove during clear(), as it will be cleared entirely
        ) {
            spliceOne(this.items, this.items.indexOf(obj));
        }

        const ref = changeTree.ref;
        const metadata: Metadata = ref.constructor[Symbol.metadata]; // ArraySchema/MapSchema do not have metadata

        const refId = ref[$refId];

        // Pre-insert any missing ancestors into view.changes so the Map's
        // iteration order stays topological — the entries we're about to
        // write (either on this obj, or on its parent collection below)
        // must come AFTER every ancestor in the chain on the wire.
        this._touchAncestorsOf(changeTree);

        let changes = this.changes.get(refId);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(refId, changes);
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // parent is collection (Map/Array)
            const parent = changeTree.parent;
            if (parent && !Metadata.isValidInstance(parent) && changeTree.isFiltered) {
                // ArraySchema parents use identity keys (see `changes` field
                // docs); Map parents keep the (stable) journal index.
                const key = parentTree!.isArray
                    ? changeTree
                    : changeTree.parentIndex;
                const parentRefId = parent[$refId];
                let changes = this.changes.get(parentRefId);
                if (changes === undefined) {
                    changes = new Map<number | ChangeTree, OPERATION>();
                    this.changes.set(parentRefId, changes);

                } else if (changes.get(key) === OPERATION.ADD) {
                    //
                    // SAME PATCH ADD + REMOVE:
                    // cancel the structure's pending ops and its descendants' —
                    // their introduction never reaches this client.
                    //
                    this._dropPendingEntries(changeTree);
                }

                // DELETE / DELETE BY REF ID
                changes.set(key, OPERATION.DELETE);

                // Remove child schema from visible set
                this._recursiveDeleteVisibleChangeTree(changeTree);

            } else {
                // delete all "tagged" properties.
                metadata?.[$viewFieldIndexes]?.forEach((index) =>
                    this._removeViewField(changeTree, changes, index));
            }

        } else {
            // delete only tagged properties. `$fieldIndexesByViewTag` is
            // keyed per-bit, so a combined tag iterates each set bit.
            const byTag = metadata?.[$fieldIndexesByViewTag];
            if (byTag !== undefined) {
                for (let bits = tag; bits > 0; bits &= bits - 1) {
                    byTag[bits & -bits]?.forEach((index) =>
                        this._removeViewField(changeTree, changes, index));
                }
            }
        }

        // remove tag bits for this view
        if (tag === undefined) {
            this.removeAllTagsOnTree(changeTree);
        } else {
            this.removeTag(changeTree, tag);
        }

        return this;
    }

    has(obj: Ref) {
        return this.isVisible(obj[$changes]);
    }

    hasTag(ob: Ref, tag: number = DEFAULT_VIEW_TAG) {
        return this.hasTagOnTree(ob[$changes], tag);
    }

    /**
     * Persistent subscription to a collection's contents. Unlike `add()`,
     * which is a one-shot bootstrap, `subscribe()` enrolls this view in
     * future content changes — every subsequent push / set / add to the
     * collection automatically flows to this view, and every removal
     * queues a DELETE op. Works on every collection type:
     *
     * - `ArraySchema` / `MapSchema` / `SetSchema` / `CollectionSchema`:
     *   new children are force-shipped immediately (equivalent to
     *   `view.add(child)` per item).
     * - `StreamSchema` (or `.stream()` maps/sets): new positions are
     *   enqueued into `_pendingByView` so the priority pass drains them
     *   respecting `maxPerTick`.
     *
     * On a streaming collection, pass a `priority` callback to order THIS
     * client's backlog. It receives only the element, so whatever the
     * client sorts by is captured in the closure — nothing is attached to
     * the view, and both the element and the captured entity stay typed:
     *
     * ```ts
     * onJoin(client) {
     *     const player = this.state.players.get(client.sessionId);
     *     client.view.subscribe(this.state.enemies, (enemy) =>
     *         -((enemy.x - player.x) ** 2 + (enemy.y - player.y) ** 2));
     * }
     * ```
     *
     * A per-view callback overrides the collection's declaration-scope
     * `.priority()` for this client only.
     *
     * Idempotent on re-subscribe: subscribing to an already-subscribed
     * collection is a no-op, EXCEPT that a supplied `priority` always
     * replaces the previous one — re-subscribe to retarget the ordering.
     * Omitting the argument leaves any existing callback in place; pass
     * `null` to drop it and fall back to the declaration-scope callback.
     */
    subscribe<V>(
        collection: StreamSchema<V> | MapSchema<V, any> | SetSchema<V> | CollectionSchema<V>,
        priority?: ((element: V) => number) | null,
    ): this;
    subscribe(collection: Ref): this;
    subscribe(collection: Ref, priority?: ((element: any) => number) | null): this {
        const tree: ChangeTree = collection?.[$changes];
        if (!tree) {
            console.warn(
                `StateView#subscribe(): expected a Schema collection, received ${describeArg(collection)}`,
            );
            return this;
        }
        if (this._root === undefined && tree.root !== undefined) {
            this._bindRoot(tree.root);
        }

        if (priority !== undefined) {
            if (!tree.isStreamCollection) {
                // Name the field rather than dumping the collection — a
                // populated MapSchema inspects into dozens of lines of
                // internals and buries the message.
                const kind = (collection as any)?.constructor?.name ?? "collection";
                const parent: any = tree.parent;
                if (parent === undefined) {
                    console.warn(
                        `StateView#subscribe(): \`priority\` ignored — this ${kind} is not ` +
                        `attached to a state yet, so it cannot be identified as a stream. ` +
                        `Subscribe after assigning it to the state.`,
                    );
                } else {
                    const field = parent?.constructor?.[Symbol.metadata]?.[tree.parentIndex]?.name;
                    const where = field ? `${parent.constructor.name}#${field}` : kind;
                    console.warn(
                        `StateView#subscribe(): \`priority\` ignored — ${where} is a ${kind}, ` +
                        `not a streaming collection. Declare the field with .stream() ` +
                        `(e.g. t.map(X).stream()) or use t.stream(X) to enable priority batching.`,
                    );
                }
            } else {
                // Set before the idempotency return below, so re-subscribing
                // is the documented way to retarget this view's ordering.
                const st = ensureStreamState(collection as unknown as Streamable);
                if (priority === null) {
                    st.priorityByView?.delete(this.id);
                } else {
                    (st.priorityByView ??= new Map()).set(this.id, priority);
                }
            }
        }

        if (this.isSubscribed(tree)) return this;

        // Mark collection visible so its own ADD/DELETE ops emit in the
        // view pass. Also flip on the subscription bit.
        this.markVisible(tree);
        this._setSubscribed(tree);

        // Bootstrap: walk current children and mark them visible to this
        // view. We DO NOT force-seed via `_addImmediate` / view.changes
        // — the encoder's natural emission paths handle it:
        //
        //   - `encodeAllView` (first-tick bootstrap): walks the tree
        //     structurally and emits every visible child.
        //   - Normal `encodeView` pass: walks `root.changes` and emits
        //     dirty children + parent collection's ADD ops.
        //
        // Seeding view.changes ourselves would cause duplicate emission,
        // fine for idempotent collections (Array/Map/Set dedup by index
        // or value), but breaks `CollectionSchema` which appends on
        // every decode-side ADD (no dedup).
        //
        // Streams are the exception — they bypass the recorder flow, so
        // subscription must enqueue positions into `_pendingByView`
        // where the priority pass drains them per `maxPerTick`.
        if (tree.isStreamCollection) {
            const streamable = collection as unknown as Streamable;
            tree.forEachChild((_child, index) => {
                streamEnqueueForView(streamable, this.id, index);
            });
        } else {
            tree.forEachChild((child) => {
                this.markVisible(child);
            });
        }

        return this;
    }

    /**
     * End a persistent subscription. Queues DELETE for every already-sent
     * child and clears any pending. After this call, future content
     * changes on the collection no longer auto-flow to this view (though
     * direct `view.add(element)` calls still work for per-entity use).
     */
    unsubscribe(collection: Ref): this {
        const tree: ChangeTree = collection?.[$changes];
        if (!tree) {
            console.warn(
                `StateView#unsubscribe(): expected a Schema collection, received ${describeArg(collection)}`,
            );
            return this;
        }
        if (!this.isSubscribed(tree)) return this;
        this._clearSubscribed(tree);

        const collectionRefId = tree.ref[$refId];

        if (tree.isStreamCollection) {
            // Streams: clear pending + queue DELETE for everything in sent.
            const st = (collection as any)._stream;
            if (st !== undefined) {
                st.pendingByView.get(this.id)?.clear();
                const sent: Set<number> | undefined = st.sentByView.get(this.id);
                if (sent !== undefined && sent.size > 0) {
                    let changes = this.changes.get(collectionRefId);
                    if (changes === undefined) {
                        changes = new Map();
                        this.changes.set(collectionRefId, changes);
                    }
                    for (const pos of sent) changes.set(pos, OPERATION.DELETE);
                    sent.clear();
                }
            }
        } else {
            // Non-streams: queue DELETE for every current child and
            // unmark their visibility so subsequent mutations stop
            // reaching this view. ArraySchema children are keyed by identity
            // (see `changes` field docs); others by their stable index.
            const isArray = tree.isArray;
            let changes = this.changes.get(collectionRefId);
            tree.forEachChild((childTree, index) => {
                if (changes === undefined) {
                    changes = new Map();
                    this.changes.set(collectionRefId, changes);
                }
                changes.set(isArray ? childTree : index, OPERATION.DELETE);
                this.unmarkVisible(childTree);
            });
        }

        // Unmark the collection itself so future ops don't emit to this
        // view (add() / subscribe() again re-marks it).
        this.unmarkVisible(tree);

        return this;
    }

    clear() {
        if (!this.iterable) {
            throw new Error("StateView#clear() is only available for iterable StateView's. Use StateView(iterable: true) constructor.");
        }

        for (let i = 0, l = this.items.length; i < l; i++) {
            this.remove(this.items[i], DEFAULT_VIEW_TAG, true);
        }

        // clear items array
        this.items.length = 0;
    }

    isChangeTreeVisible(changeTree: ChangeTree) {
        let isVisible = this.isVisible(changeTree);

        // The parent-visibility fallback handles child collections without
        // their own @view tag (see StateView.test.ts "should not be required
        // to manually call view.add() items to child arrays..."). The
        // `isVisibilitySharedWithParent` flag — precomputed at attach-time in
        // inheritedFlags.ts — short-circuits for the common case, and
        // `markVisible` memoizes so the branch fires at most once per
        // (tree, view) pair.
        if (!isVisible && changeTree.isVisibilitySharedWithParent){
            // Primary grant is intentionally unguarded — pre-existing
            // semantics; the extras walk below is stricter on purpose.
            if (this.isVisible(changeTree.parent[$changes])) {
                this.markVisible(changeTree);
                isVisible = true;
            } else {
                // Shared instance: the sharing parent may sit anywhere in the
                // chain — addParent promotes the LAST container to primary.
                // Only filtered parents can grant (public ones never share
                // visibility downward).
                for (let e = changeTree.extraParents; e !== undefined; e = e.next) {
                    const parentTree = e.ref[$changes];
                    if (parentTree.isFiltered && this.isVisible(parentTree)) {
                        this.markVisible(changeTree);
                        isVisible = true;
                        break;
                    }
                }
            }
        }

        return isVisible;
    }

    protected _recursiveDeleteVisibleChangeTree(changeTree: ChangeTree) {
        changeTree.forEachChild((childChangeTree) => {
            this.unmarkVisible(childChangeTree);
            this._recursiveDeleteVisibleChangeTree(childChangeTree);
        });
    }

    /**
     * Drop the pending `view.changes` entries of `tree` and every descendant.
     * Called when a same-patch pending ADD is cancelled: the subtree's
     * introduction never reaches this client, so its entries would emit
     * refIds the decoder cannot resolve ("refId" not found).
     */
    private _dropPendingEntries(tree: ChangeTree): void {
        this.changes.delete(tree.ref[$refId]);
        tree.forEachChild((child) => this._dropPendingEntries(child));
    }

    /**
     * Queue DELETE for a @view field on `changes` and hide the field
     * value's subtree from this view. When the field's ADD is still
     * pending (same-patch add + remove), the value's introduction never
     * ships — its pending subtree entries are dropped along with it.
     */
    private _removeViewField(changeTree: ChangeTree, changes: Map<number | ChangeTree, OPERATION>, index: number): void {
        const wasPendingAdd = changes.get(index) === OPERATION.ADD;
        changes.set(index, OPERATION.DELETE);

        const value = changeTree.ref[changeTree.encDescriptor.names[index] as keyof Ref];
        const valueTree: ChangeTree = value?.[$changes];
        if (valueTree) {
            this.unmarkVisible(valueTree);
            this._recursiveDeleteVisibleChangeTree(valueTree);
            if (wasPendingAdd) {
                this._dropPendingEntries(valueTree);
            }
        }
    }
}
