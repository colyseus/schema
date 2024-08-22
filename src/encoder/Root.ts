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
        const refCount = this.refCount.get(changeTree) || 0;
        this.refCount.set(changeTree, refCount + 1);
    }

    remove(changeTree: ChangeTree) {
        const refCount = this.refCount.get(changeTree);
        if (refCount <= 1) {
            this.allChanges.delete(changeTree);
            this.changes.delete(changeTree);

            if (changeTree.isFiltered || changeTree.isPartiallyFiltered) {
                this.allFilteredChanges.delete(changeTree);
                this.filteredChanges.delete(changeTree);
            }

            this.refCount.delete(changeTree);

        } else {
            this.refCount.set(changeTree, refCount - 1);
        }

        changeTree.forEachChild((child, _) => this.remove(child));
    }

    clear() {
        this.changes.clear();
    }
}
