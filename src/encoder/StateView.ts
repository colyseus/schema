import { ChangeTree, Ref } from "./ChangeTree.js";
import { $changes, $fieldIndexesByViewTag, $refId, $viewFieldIndexes } from "../types/symbols.js";
import { DEFAULT_VIEW_TAG } from "../annotations.js";
import { OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { spliceOne } from "../types/utils.js";
import type { Schema } from "../Schema.js";
import type { Root } from "./Root.js";

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

    tags?: WeakMap<ChangeTree, Set<number>>; // TODO: use bit manipulation instead of Set<number> ()

    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (This is used to force encoding a property, even if it was not changed)
     */
    changes = new Map<number, { [index: number]: OPERATION }>();

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

    // TODO: allow to set multiple tags at once
    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG, checkIncludeParent: boolean = true) {
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
             * TODO: can we avoid this?
             *
             * When the "parent" structure has the @view() tag, it is currently
             * not possible to identify it has to be added to the view as well
             * (this.addParentOf() is not called).
             */
            throw new Error(
                `Cannot add a detached instance to the StateView. Make sure to assign the "${changeTree.ref.constructor.name}" instance to the state before calling view.add()`
            );
        }

        // FIXME: ArraySchema/MapSchema do not have metadata
        const metadata: Metadata = (obj.constructor as typeof Schema)[Symbol.metadata];

        // Bind to Root + acquire view ID on first add(). Until then, we have
        // no per-tree bit position to write into.
        if (this._root === undefined && changeTree.root !== undefined) {
            this._bindRoot(changeTree.root);
        }
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

        let changes = this.changes.get(obj[$refId]);
        if (changes === undefined) {
            changes = {};
            // FIXME / OPTIMIZE: do not add if no changes are needed
            this.changes.set(obj[$refId], changes);
        }

        let isChildAdded = false;

        //
        // Add children of this ChangeTree first.
        // If successful, we must link the current ChangeTree to the child.
        //
        changeTree.forEachChild((change, index) => {
            // Do not ADD children that don't have the same tag
            if (
                metadata &&
                metadata[index].tag !== undefined &&
                metadata[index].tag !== tag
            ) {
                return;
            }

            if (this.add(change.ref, tag, false)) {
                isChildAdded = true;
            }
        });

        // set tag
        if (tag !== DEFAULT_VIEW_TAG) {
            if (!this.tags) {
                this.tags = new WeakMap<ChangeTree, Set<number>>();
            }
            let tags: Set<number>;
            if (!this.tags.has(changeTree)) {
                tags = new Set<number>();
                this.tags.set(changeTree, tags);
            } else {
                tags = this.tags.get(changeTree);
            }
            tags.add(tag);

            // Ref: add tagged properties
            metadata?.[$fieldIndexesByViewTag]?.[tag]?.forEach((index) => {
                if (changeTree.getChange(index) !== OPERATION.DELETE) {
                    changes[index] = OPERATION.ADD;
                }
            });

        } else if (!changeTree.isNew || isChildAdded) {
            // new structures will be added as part of .encode() call, no need to force it to .encodeView()
            const isInvisible = this.isInvisible(changeTree);

            // Full-sync snapshot: walk the live ref structurally instead of
            // iterating a cumulative recorder bucket. Every populated index
            // is emitted as ADD (matching the op-coercion previously done
            // at encode time).
            changeTree.forEachLive((index) => {
                const tagAtIndex = metadata?.[index]?.tag;
                if (
                    isInvisible || // if "invisible", include all
                    tagAtIndex === undefined || // "all change" with no tag
                    tagAtIndex === tag // tagged property
                ) {
                    changes[index] = OPERATION.ADD;
                    isChildAdded = true; // FIXME: assign only once
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
                changes = {};
                this.changes.set(changeTree.ref[$refId], changes);
            }

            if (!this.tags) {
                this.tags = new WeakMap<ChangeTree, Set<number>>();
            }

            let tags: Set<number>;
            if (!this.tags.has(changeTree)) {
                tags = new Set<number>();
                this.tags.set(changeTree, tags);
            } else {
                tags = this.tags.get(changeTree);
            }
            tags.add(tag);

            changes[parentIndex] = OPERATION.ADD;
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
            changes = {};
            this.changes.set(refId, changes);
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // parent is collection (Map/Array)
            const parent = changeTree.parent;
            if (parent && !Metadata.isValidInstance(parent) && changeTree.isFiltered) {
                const parentRefId = parent[$refId];
                let changes = this.changes.get(parentRefId);
                if (changes === undefined) {
                    changes = {};
                    this.changes.set(parentRefId, changes);

                } else if (changes[changeTree.parentIndex] === OPERATION.ADD) {
                    //
                    // SAME PATCH ADD + REMOVE:
                    // The 'changes' of deleted structure should be ignored.
                    //
                    this.changes.delete(refId);
                }

                // DELETE / DELETE BY REF ID
                changes[changeTree.parentIndex] = OPERATION.DELETE;

                // Remove child schema from visible set
                this._recursiveDeleteVisibleChangeTree(changeTree);

            } else {
                // delete all "tagged" properties.
                metadata?.[$viewFieldIndexes]?.forEach((index) => {
                    changes[index] = OPERATION.DELETE;

                    // Remove child structures of @view() fields from visible set.
                    // (They were added during view.add() via forEachChild)
                    const value = changeTree.ref[metadata[index].name as keyof Ref];
                    if (value?.[$changes]) {
                        this.unmarkVisible(value[$changes]);
                        this._recursiveDeleteVisibleChangeTree(value[$changes]);
                    }
                });
            }

        } else {
            // delete only tagged properties
            metadata?.[$fieldIndexesByViewTag][tag].forEach((index) => {
                changes[index] = OPERATION.DELETE;

                // Remove child structures from visible set
                const value = changeTree.ref[metadata[index].name as keyof Ref];
                if (value?.[$changes]) {
                    this.unmarkVisible(value[$changes]);
                    this._recursiveDeleteVisibleChangeTree(value[$changes]);
                }
            });
        }

        // remove tag
        if (this.tags && this.tags.has(changeTree)) {
            const tags = this.tags.get(changeTree);
            if (tag === undefined) {
                // delete all tags
                this.tags.delete(changeTree);
            } else {
                // delete specific tag
                tags.delete(tag);

                // if tag set is empty, delete it entirely
                if (tags.size === 0) {
                    this.tags.delete(changeTree);
                }
            }
        }

        return this;
    }

    has(obj: Ref) {
        return this.isVisible(obj[$changes]);
    }

    hasTag(ob: Ref, tag: number = DEFAULT_VIEW_TAG) {
        const tags = this.tags?.get(ob[$changes]);
        return tags?.has(tag) ?? false;
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

        //
        // TODO: avoid checking for parent visibility, most of the time it's not needed
        // See test case: 'should not be required to manually call view.add() items to child arrays without @view() tag'
        //
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
