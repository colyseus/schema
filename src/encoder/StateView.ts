import { ChangeTree, Ref } from "./ChangeTree";
import { $changes } from "../types/symbols";
import { DEFAULT_VIEW_TAG } from "../annotations";
import { OPERATION } from "../encoding/spec";
import { Metadata } from "../Metadata";

export class StateView {
    /**
     * List of ChangeTree's that are visible to this view
     */
    items: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    /**
     * List of ChangeTree's that are invisible to this view
     */
    invisible: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();

    tags?: WeakMap<ChangeTree, Set<number>>; // TODO: use bit manipulation instead of Set<number> ()

    /**
     * Manual "ADD" operations for changes per ChangeTree, specific to this view.
     * (This is used to force encoding a property, even if it was not changed)
     */
    changes = new Map<ChangeTree, Map<number, OPERATION>>();

    // TODO: allow to set multiple tags at once
    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG) {
        if (!obj[$changes]) {
            console.warn("StateView#add(), invalid object:", obj);
            return this;
        }

        let changeTree: ChangeTree = obj[$changes];
        this.items.add(changeTree);

        // Add children of this ChangeTree to this view
        changeTree.forEachChild((change, _) =>
            this.add(change.ref, tag));

        // FIXME: ArraySchema/MapSchema does not have metadata
        const metadata: Metadata = obj.constructor[Symbol.metadata];

        // add parent ChangeTree's, if they are invisible to this view
        // TODO: REFACTOR addParent()
        this.addParent(changeTree, tag);

        //
        // TODO: when adding an item of a MapSchema, the changes may not
        // be set (only the parent's changes are set)
        //
        let changes = this.changes.get(changeTree);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(changeTree, changes)
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

            // console.log("BY TAG:", tag);

            // Ref: add tagged properties
            metadata?.[-3]?.[tag]?.forEach((index) => {
                if (changeTree.getChange(index) !== OPERATION.DELETE) {
                    changes.set(index, OPERATION.ADD)
                }
            });

        } else {

            // console.log("DEFAULT TAG", changeTree.allChanges);

            // // add default tag properties
            // metadata?.[-3]?.[DEFAULT_VIEW_TAG]?.forEach((index) => {
            //     if (changeTree.getChange(index) !== OPERATION.DELETE) {
            //         changes.set(index, OPERATION.ADD);
            //     }
            // });

            const it = changeTree.allChanges.keys();
            const isInvisible = this.invisible.has(changeTree);

            for (const index of it) {
                if (
                    (isInvisible || metadata?.[metadata?.[index]].tag === tag) &&
                    changeTree.getChange(index) !== OPERATION.DELETE
                ) {
                    changes.set(index, OPERATION.ADD);
                }
            }
        }

        // TODO: avoid unnecessary iteration here
        while (
            changeTree.parent &&
            (changeTree = changeTree.parent[$changes]) &&
            (changeTree.isFiltered || changeTree.isPartiallyFiltered)
        ) {
            this.items.add(changeTree);
        }

        return this;
    }

    protected addParent(changeTree: ChangeTree, tag: number) {
        const parentRef = changeTree.parent;
        if (!parentRef) { return; }

        const parentChangeTree = parentRef[$changes];
        const parentIndex = changeTree.parentIndex;

        if (!this.invisible.has(parentChangeTree)) {
            // parent is already available, no need to add it!
            return;
        }

        this.addParent(parentChangeTree, tag);

        // add parent's tag properties
        if (parentChangeTree.getChange(parentIndex) !== OPERATION.DELETE) {

            let parentChanges = this.changes.get(parentChangeTree);
            if (parentChanges === undefined) {
                parentChanges = new Map<number, OPERATION>();
                this.changes.set(parentChangeTree, parentChanges);
            }

            // console.log("add parent change", {
            //     parentIndex,
            //     parentChanges,
            //     parentChange: (
            //         parentChangeTree.getChange(parentIndex) &&
            //         OPERATION[parentChangeTree.getChange(parentIndex)]
            //     ),
            // })

            if (!this.tags) { this.tags = new WeakMap<ChangeTree, Set<number>>(); }
            let tags: Set<number>;
            if (!this.tags.has(parentChangeTree)) {
                tags = new Set<number>();
                this.tags.set(parentChangeTree, tags);
            } else {
                tags = this.tags.get(parentChangeTree);
            }
            tags.add(tag);

            parentChanges.set(parentIndex, OPERATION.ADD);
        }

    }

    remove(obj: Ref, tag: number = DEFAULT_VIEW_TAG) {
        const changeTree = obj[$changes];
        if (!changeTree) {
            console.warn("StateView#remove(), invalid object:", obj);
            return this;
        }

        this.items.delete(changeTree);

        const ref = changeTree.ref;
        const metadata: Metadata = ref.constructor[Symbol.metadata];

        let changes = this.changes.get(changeTree);
        if (changes === undefined) {
            changes = new Map<number, OPERATION>();
            this.changes.set(changeTree, changes)
        }

        if (tag === DEFAULT_VIEW_TAG) {
            // delete all "tagged" properties.
            metadata[-2].forEach((index) =>
                changes.set(index, OPERATION.DELETE));

        } else {
            // delete only tagged properties
            metadata[-3][tag].forEach((index) =>
                changes.set(index, OPERATION.DELETE));
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
}