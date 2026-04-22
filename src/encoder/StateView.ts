import { ChangeTree, Ref } from "./ChangeTree.js";
import { $changes, $fieldIndexesByViewTag, $refId, $viewFieldIndexes } from "../types/symbols.js";
import { DEFAULT_VIEW_TAG } from "../annotations.js";
import { OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { spliceOne } from "../types/utils.js";
import { streamDequeueForView, streamEnqueueForView } from "./streaming.js";
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
        const i = tree.invisibleViews;
        if (i !== undefined && slot < i.length) i[slot] &= clearMask;
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
     */
    changes = new Map<number, Map<number, OPERATION>>();

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

    /** True iff this view has previously marked `tree` as invisible. */
    public isInvisible(tree: ChangeTree): boolean {
        const arr = tree.invisibleViews;
        const slot = this._slot;
        return arr !== undefined && slot < arr.length && (arr[slot] & this._bit) !== 0;
    }

    /** Mark `tree` as invisible to this view (used by encode loop). */
    public markInvisible(tree: ChangeTree): void {
        const slot = this._slot;
        let arr = tree.invisibleViews;
        if (arr === undefined) {
            arr = tree.invisibleViews = [];
        }
        while (arr.length <= slot) arr.push(0);
        arr[slot] |= this._bit;
    }

    /** Clear invisible bit. */
    public unmarkInvisible(tree: ChangeTree): void {
        const arr = tree.invisibleViews;
        if (arr === undefined) return;
        const slot = this._slot;
        if (slot < arr.length) arr[slot] &= ~this._bit;
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-tag, per-view bitmap. Replaces the legacy
    // `tags: WeakMap<ChangeTree, Set<number>>` storage. Hot read site is
    // `Schema.ts` filter check — `hasTagOnTree` is O(1) bitwise.
    // ──────────────────────────────────────────────────────────────────

    /** True iff this view has `tag` associated with `tree`. */
    public hasTagOnTree(tree: ChangeTree, tag: number): boolean {
        const map = tree.tagViews;
        if (map === undefined) return false;
        const arr = map.get(tag);
        const slot = this._slot;
        return arr !== undefined && slot < arr.length && (arr[slot] & this._bit) !== 0;
    }

    /** Mark `tree` as carrying `tag` for this view. */
    public addTag(tree: ChangeTree, tag: number): void {
        let map = tree.tagViews;
        if (map === undefined) {
            map = tree.tagViews = new Map();
        }
        let arr = map.get(tag);
        if (arr === undefined) {
            arr = [];
            map.set(tag, arr);
        }
        const slot = this._slot;
        while (arr.length <= slot) arr.push(0);
        arr[slot] |= this._bit;
    }

    /** Clear this view's `tag` bit on `tree`. */
    public removeTag(tree: ChangeTree, tag: number): void {
        const map = tree.tagViews;
        if (map === undefined) return;
        const arr = map.get(tag);
        if (arr === undefined) return;
        const slot = this._slot;
        if (slot < arr.length) arr[slot] &= ~this._bit;
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
        const parentChangeTree = changeTree.parent;

        if (!changeTree) {
            console.warn("StateView#add(), invalid object:", obj);
            return false;

        } else if (
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

        this.markVisible(changeTree);

        // add to iterable list (only the explicitly added items)
        if (this.iterable && checkIncludeParent) {
            this.items.push(obj);
        }

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

        let changes = this.changes.get(obj[$refId]);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            // FIXME / OPTIMIZE: do not add if no changes are needed
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
            // Do not ADD children that don't have the same tag
            const fieldTag = tags[index];
            if (fieldTag !== undefined && fieldTag !== tag) {
                return;
            }

            if (this.add(change.ref, tag, false)) {
                isChildAdded = true;
            }
        });

        // set tag
        if (tag !== DEFAULT_VIEW_TAG) {
            this.addTag(changeTree, tag);

            // Ref: add tagged properties
            metadata?.[$fieldIndexesByViewTag]?.[tag]?.forEach((index) => {
                if (changeTree.getChange(index) !== OPERATION.DELETE) {
                    changes.set(index, OPERATION.ADD);
                }
            });

        } else if (!changeTree.isNew || isChildAdded) {
            // new structures will be added as part of .encode() call, no need to force it to .encodeView()
            const isInvisible = this.isInvisible(changeTree);

            // Full-sync snapshot: walk the live ref structurally instead of
            // iterating a cumulative recorder bucket. Every populated index
            // is emitted as ADD (matching the op-coercion previously done
            // at encode time). Per-field tags come from the descriptor's
            // precomputed `tags[]` array — direct index vs a metadata[i].tag
            // object hop.
            const tags = changeTree.encDescriptor.tags;
            changeTree.forEachLive((index) => {
                const tagAtIndex = tags[index];
                if (
                    isInvisible || // if "invisible", include all
                    tagAtIndex === undefined || // "all change" with no tag
                    tagAtIndex === tag // tagged property
                ) {
                    changes.set(index, OPERATION.ADD);
                    isChildAdded = true;
                }
            });
        }

        return isChildAdded;
    }

    protected addParentOf(childChangeTree: ChangeTree, tag: number) {
        const changeTree = childChangeTree.parent[$changes];
        const parentIndex = childChangeTree.parentIndex;

        if (!this.isVisible(changeTree)) {
            // view must have all "changeTree" parent tree
            this.markVisible(changeTree);

            // add parent's parent
            const parentChangeTree: ChangeTree = changeTree.parent?.[$changes];
            if (parentChangeTree && parentChangeTree.hasFilteredFields) {
                this.addParentOf(changeTree, tag);
            }
        }

        // add parent's tag properties
        if (changeTree.getChange(parentIndex) !== OPERATION.DELETE) {
            let changes = this.changes.get(changeTree.ref[$refId]);
            if (changes === undefined) {
                changes = new Map<number, OPERATION>();
                this.changes.set(changeTree.ref[$refId], changes);
            }

            this.addTag(changeTree, tag);

            changes.set(parentIndex, OPERATION.ADD);
        }
    }

    remove(obj: Ref, tag?: number): this; // hide _isClear parameter from public API
    remove(obj: Ref, tag?: number, _isClear?: boolean): this;
    remove(obj: Ref, tag: number = DEFAULT_VIEW_TAG, _isClear: boolean = false): this {
        const changeTree: ChangeTree = obj[$changes];
        if (!changeTree) {
            console.warn("StateView#remove(), invalid object:", obj);
            return this;
        }

        // ── Streamable-element unsubscribe ─────────────────────────────
        // Symmetric to the `add(streamElement)` routing: pull the element
        // out of the stream's per-view state. If it never made it to the
        // wire (still in pending), silent drop; if already sent, queue
        // DELETE via `view.changes` for the next encodeView drain.
        const parentStreamTree = changeTree.parent?.[$changes];
        if (parentStreamTree?.isStreamCollection) {
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
        // this, the stream is marked invisible to this view — any future
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

        let changes = this.changes.get(refId);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(refId, changes);
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // parent is collection (Map/Array)
            const parent = changeTree.parent;
            if (parent && !Metadata.isValidInstance(parent) && changeTree.isFiltered) {
                const parentRefId = parent[$refId];
                let changes = this.changes.get(parentRefId);
                if (changes === undefined) {
                    changes = new Map<number, OPERATION>();
                    this.changes.set(parentRefId, changes);

                } else if (changes.get(changeTree.parentIndex) === OPERATION.ADD) {
                    //
                    // SAME PATCH ADD + REMOVE:
                    // The 'changes' of deleted structure should be ignored.
                    //
                    this.changes.delete(refId);
                }

                // DELETE / DELETE BY REF ID
                changes.set(changeTree.parentIndex, OPERATION.DELETE);

                // Remove child schema from visible set
                this._recursiveDeleteVisibleChangeTree(changeTree);

            } else {
                // delete all "tagged" properties.
                const names = changeTree.encDescriptor.names;
                metadata?.[$viewFieldIndexes]?.forEach((index) => {
                    changes.set(index, OPERATION.DELETE);

                    // Remove child structures of @view() fields from visible set.
                    // (They were added during view.add() via forEachChild)
                    const value = changeTree.ref[names[index] as keyof Ref];
                    if (value?.[$changes]) {
                        this.unmarkVisible(value[$changes]);
                        this._recursiveDeleteVisibleChangeTree(value[$changes]);
                    }
                });
            }

        } else {
            // delete only tagged properties
            const names = changeTree.encDescriptor.names;
            metadata?.[$fieldIndexesByViewTag][tag].forEach((index) => {
                changes.set(index, OPERATION.DELETE);

                // Remove child structures from visible set
                const value = changeTree.ref[names[index] as keyof Ref];
                if (value?.[$changes]) {
                    this.unmarkVisible(value[$changes]);
                    this._recursiveDeleteVisibleChangeTree(value[$changes]);
                }
            });
        }

        // remove tag bit for this view
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
     * Idempotent on re-subscribe. Subscribing to an already-subscribed
     * collection is a no-op.
     */
    subscribe(collection: Ref): this {
        const tree: ChangeTree = collection?.[$changes];
        if (!tree) {
            console.warn("StateView#subscribe(), invalid collection:", collection);
            return this;
        }
        if (this._root === undefined && tree.root !== undefined) {
            this._bindRoot(tree.root);
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
            console.warn("StateView#unsubscribe(), invalid collection:", collection);
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
            // reaching this view.
            let changes = this.changes.get(collectionRefId);
            tree.forEachChild((childTree, index) => {
                if (changes === undefined) {
                    changes = new Map();
                    this.changes.set(collectionRefId, changes);
                }
                changes.set(index, OPERATION.DELETE);
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
            if (this.isVisible(changeTree.parent[$changes])) {
                this.markVisible(changeTree);
                isVisible = true;
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
}
