import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { ChangeTree, enqueueChangeTree, setOperationAtIndex } from "./ChangeTree";

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
        // Assign unique `refId` to changeTree if it doesn't have one yet.
        if (changeTree.refId === undefined) {
            changeTree.refId = this.getNextUniqueId();
        }

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
        console.log("REMOVE", changeTree.refId, refCount);

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

            // changeTree.forEachChild((child, _) => this.remove(child));
            changeTree.forEachChild((child, _) => {
                if (child.removeParent(changeTree.ref)) {
                    this.remove(child);
                }
            });

        } else {
            this.refCount[changeTree.refId] = refCount;

            //
            // When losing a reference to an instance, it is best to move the
            // ChangeTree to the end of the encoding queue.
            //
            // This way, at decoding time, the instance that contains the
            // ChangeTree will be available before the ChangeTree itself. If the
            // containing instance is not available, the Decoder will throw
            // "refId not found" error.
            //
            this.moveToEnd(changeTree);
            changeTree.forEachChild((child, _) => this.moveToEnd(child));
        }

        return refCount;
    }

    protected moveToEnd(changeTree: ChangeTree) {
        console.log("MOVE TO END", changeTree.refId);
        if (changeTree.filteredChanges !== undefined) {
            this.removeChangeFromChangeSet("filteredChanges", changeTree);
            enqueueChangeTree(this, changeTree, "filteredChanges");
        } else {
            this.removeChangeFromChangeSet("changes", changeTree);
            enqueueChangeTree(this, changeTree, "changes");
        }
    }

    protected removeChangeFromChangeSet(changeSetName: "allChanges" | "changes" | "filteredChanges" | "allFilteredChanges", changeTree: ChangeTree) {
        const changeSet = this[changeSetName];
        const changeSetIndex = changeSet.indexOf(changeTree);

        if (changeSetIndex !== -1) {
            changeTree[changeSetName].queueRootIndex = -1;
            changeSet[changeSetIndex] = undefined;
            return true;
        }

        // if (spliceOne(changeSet, changeSet.indexOf(changeTree))) {
        //     changeTree[changeSetName].queueRootIndex = -1;
        //     return true;
        // }
    }

    clear() {
        this.changes.length = 0;
    }
}
