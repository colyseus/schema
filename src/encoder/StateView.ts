import { ChangeSet, ChangeTree, IndexedOperations, Ref } from "./ChangeTree";
import { $changes, $fieldIndexesByViewTag, $viewFieldIndexes } from "../types/symbols";
import { DEFAULT_VIEW_TAG } from "../annotations";
import { OPERATION } from "../encoding/spec";
import { Metadata } from "../Metadata";
import { spliceOne } from "../types/utils";

export function createView(iterable: boolean = false) {
    return new StateView(iterable);
}

export class StateView {
    /**
     * Iterable list of items that are visible to this view
     * (Available only if constructed with `iterable: true`)
     */
    items: Ref[];

    /**
     * List of ChangeTree's that are visible to this view
     */
    visible: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    /**
     * List of ChangeTree's that are invisible to this view
     */
    invisible: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    tags?: WeakMap<ChangeTree, Set<number>>; // TODO: use bit manipulation instead of Set<number> ()

    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (This is used to force encoding a property, even if it was not changed)
     */
    changes = new Map<number, IndexedOperations>();

    constructor(public iterable: boolean = false) {
        if (iterable) {
            this.items = [];
        }
    }

    // TODO: allow to set multiple tags at once
    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG, checkIncludeParent: boolean = true) {
        const changeTree: ChangeTree = obj?.[$changes];

        if (!changeTree) {
            console.warn("StateView#add(), invalid object:", obj);
            return this;

        } else if (
            !changeTree.parent &&
            changeTree.refId !== 0 // allow root object
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
        const metadata: Metadata = obj.constructor[Symbol.metadata];
        this.visible.add(changeTree);

        // add to iterable list (only the explicitly added items)
        if (this.iterable && checkIncludeParent) {
            this.items.push(obj);
        }

        // add parent ChangeTree's
        // - if it was invisible to this view
        // - if it were previously filtered out
        if (checkIncludeParent && changeTree.parent) {
            this.addParentOf(changeTree, tag);
        }

        //
        // TODO: when adding an item of a MapSchema, the changes may not
        // be set (only the parent's changes are set)
        //
        let changes = this.changes.get(changeTree.refId);
        if (changes === undefined) {
            changes = {};
            this.changes.set(changeTree.refId, changes);
        }

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

        } else {
            const isInvisible = this.invisible.has(changeTree);
            const changeSet = (changeTree.filteredChanges !== undefined)
                ? changeTree.allFilteredChanges
                : changeTree.allChanges;

            for (let i = 0, len = changeSet.operations.length; i < len; i++) {
                const index = changeSet.operations[i];
                if (index === undefined) { continue; } // skip "undefined" indexes

                const op = changeTree.indexedOperations[index] ?? OPERATION.ADD;
                const tagAtIndex = metadata?.[index].tag;
                if (
                    !changeTree.isNew && // new structures will be added as part of .encode() call, no need to force it to .encodeView()
                    (
                        isInvisible || // if "invisible", include all
                        tagAtIndex === undefined || // "all change" with no tag
                        tagAtIndex === tag // tagged property
                    ) &&
                    op !== OPERATION.DELETE
                ) {
                    changes[index] = op;
                }
            }
        }

        // Add children of this ChangeTree to this view
        changeTree.forEachChild((change, index) => {
            // Do not ADD children that don't have the same tag
            if (
                metadata &&
                metadata[index].tag !== undefined &&
                metadata[index].tag !== tag
            ) {
                return;
            }
            this.add(change.ref, tag, false);
        });

        return this;
    }

    protected addParentOf(childChangeTree: ChangeTree, tag: number) {
        const changeTree = childChangeTree.parent[$changes];
        const parentIndex = childChangeTree.parentIndex;

        if (!this.visible.has(changeTree)) {
            // view must have all "changeTree" parent tree
            this.visible.add(changeTree);

            // add parent's parent
            const parentChangeTree: ChangeTree = changeTree.parent?.[$changes];
            if (parentChangeTree && (parentChangeTree.filteredChanges !== undefined)) {
                this.addParentOf(changeTree, tag);
            }

            // // parent is already available, no need to add it!
            // if (!this.invisible.has(changeTree)) { return; }
        }

        // add parent's tag properties
        if (changeTree.getChange(parentIndex) !== OPERATION.DELETE) {
            let changes = this.changes.get(changeTree.refId);
            if (changes === undefined) {
                changes = {};
                this.changes.set(changeTree.refId, changes);
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

        this.visible.delete(changeTree);

        // remove from iterable list
        if (
            this.iterable &&
            !_isClear // no need to remove during clear(), as it will be cleared entirely
        ) {
            spliceOne(this.items, this.items.indexOf(obj));
        }

        const ref = changeTree.ref;
        const metadata: Metadata = ref.constructor[Symbol.metadata]; // ArraySchema/MapSchema do not have metadata

        let changes = this.changes.get(changeTree.refId);
        if (changes === undefined) {
            changes = {};
            this.changes.set(changeTree.refId, changes);
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // parent is collection (Map/Array)
            const parent = changeTree.parent;
            if (!Metadata.isValidInstance(parent) && changeTree.isFiltered) {
                const parentChangeTree = parent[$changes];
                let changes = this.changes.get(parentChangeTree.refId);
                if (changes === undefined) {
                    changes = {};
                    this.changes.set(parentChangeTree.refId, changes);
                }
                // DELETE / DELETE BY REF ID
                changes[changeTree.parentIndex] = OPERATION.DELETE;

            } else {
                // delete all "tagged" properties.
                metadata?.[$viewFieldIndexes]?.forEach((index) =>
                    changes[index] = OPERATION.DELETE);
            }

        } else {
            // delete only tagged properties
            metadata?.[$fieldIndexesByViewTag][tag].forEach((index) =>
                changes[index] = OPERATION.DELETE);
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
        return this.visible.has(obj[$changes]);
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
        let isVisible = this.visible.has(changeTree);

        //
        // TODO: avoid checking for parent visibility, most of the time it's not needed
        // See test case: 'should not be required to manually call view.add() items to child arrays without @view() tag'
        //
        if (!isVisible && changeTree.isVisibilitySharedWithParent){

            // console.log("CHECK AGAINST PARENT...", {
            //     ref: changeTree.ref.constructor.name,
            //     refId: changeTree.refId,
            //     parent: changeTree.parent.constructor.name,
            // });

            if (this.visible.has(changeTree.parent[$changes])) {
                this.visible.add(changeTree);
                isVisible = true;
            }
        }

        return isVisible;
    }
}
