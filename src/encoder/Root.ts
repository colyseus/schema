import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { ChangeTree } from "./ChangeTree";

export class Root {
    protected nextUniqueId: number = 0;
    refCount = new WeakMap<ChangeTree, number>();

    // all changes
    allChanges = new Map<ChangeTree, Map<number, OPERATION>>();
    allFilteredChanges = new Map<ChangeTree, Map<number, OPERATION>>();

    // pending changes to be encoded
    changes = new Map<ChangeTree, Map<number, OPERATION>>();
    filteredChanges = new Map<ChangeTree, Map<number, OPERATION>>();

    constructor(public types: TypeContext) { }

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    add(changeTree: ChangeTree) {
        const previousRefCount = this.refCount.get(changeTree);

        if (previousRefCount === 0) {
            //
            // When a ChangeTree is re-added, it means that it was previously removed.
            // We need to re-add all changes to the `changes` map.
            //
            changeTree.allChanges.forEach((operation, index) => {
                changeTree.changes.set(index, operation);
            });
        }

        const refCount = (previousRefCount || 0) + 1;
        this.refCount.set(changeTree, refCount);

        return refCount;
    }

    remove(changeTree: ChangeTree) {
        const refCount = (this.refCount.get(changeTree)) - 1;

        if (refCount <= 0) {
            //
            // Only remove "root" reference if it's the last reference
            //
            changeTree.root = undefined;

            this.allChanges.delete(changeTree);
            this.changes.delete(changeTree);

            if (changeTree.isFiltered || changeTree.isPartiallyFiltered) {
                this.allFilteredChanges.delete(changeTree);
                this.filteredChanges.delete(changeTree);
            }

            this.refCount.set(changeTree, 0);

        } else {
            this.refCount.set(changeTree, refCount);
        }

        changeTree.forEachChild((child, _) => this.remove(child));

        return refCount;
    }

    clear() {
        this.changes.clear();
    }
}
