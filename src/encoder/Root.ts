import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { spliceOne } from "../types/utils";
import { ChangeTree, setOperationAtIndex } from "./ChangeTree";

export class Root {
    protected nextUniqueId: number = 0;

    refCount: {[id: number]: number} = {};
    changeTrees: {[refId: number]: ChangeTree} = {};

    // all changes
    allChanges: ChangeTree[] = [];
    allFilteredChanges: ChangeTree[] = [];// TODO: do not initialize it if filters are not used

    // pending changes to be encoded
    changes: ChangeTree[] = [];
    filteredChanges: ChangeTree[] = [];// TODO: do not initialize it if filters are not used

    constructor(public types: TypeContext) { }

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    add(changeTree: ChangeTree) {
        // FIXME: move implementation of `ensureRefId` to `Root` class
        changeTree.ensureRefId();

        const isNewChangeTree = (this.changeTrees[changeTree.refId] === undefined);
        if (isNewChangeTree) { this.changeTrees[changeTree.refId] = changeTree; }

        const previousRefCount = this.refCount[changeTree.refId];
        if (previousRefCount === 0) {
            //
            // When a ChangeTree is re-added, it means that it was previously removed.
            // We need to re-add all changes to the `changes` map.
            //
            const ops = changeTree.allChanges.operations;
            let len = ops.length;
            while (len--) {
                changeTree.indexedOperations[ops[len]] = OPERATION.ADD;
                setOperationAtIndex(changeTree.changes, len);
            }
        }

        this.refCount[changeTree.refId] = (previousRefCount || 0) + 1;

        return isNewChangeTree;
    }

    remove(changeTree: ChangeTree) {
        const refCount = (this.refCount[changeTree.refId]) - 1;

        if (refCount <= 0) {
            //
            // Only remove "root" reference if it's the last reference
            //
            changeTree.root = undefined;
            delete this.changeTrees[changeTree.refId];

            this.removeChangeFromChangeSet("allChanges", changeTree);
            this.removeChangeFromChangeSet("changes", changeTree);

            if (changeTree.filteredChanges) {
                this.removeChangeFromChangeSet("allFilteredChanges", changeTree);
                this.removeChangeFromChangeSet("filteredChanges", changeTree);
            }

            this.refCount[changeTree.refId] = 0;

        } else {
            this.refCount[changeTree.refId] = refCount;
        }

        changeTree.forEachChild((child, _) => this.remove(child));

        return refCount;
    }

    removeChangeFromChangeSet(changeSetName: "allChanges" | "changes" | "filteredChanges" | "allFilteredChanges", changeTree: ChangeTree) {
        const changeSet = this[changeSetName];
        const index = changeSet.indexOf(changeTree);
        if (index !== -1) {
            spliceOne(changeSet, index);
            // changeSet[index] = undefined;
        }
    }

    clear() {
        this.changes.length = 0;
    }
}
