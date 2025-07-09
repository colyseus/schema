import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { ChangeTree, enqueueChangeTree, setOperationAtIndex, ChangeTreeList, createChangeTreeList, moveToEndOfChangeTreeList } from "./ChangeTree";

export class Root {
    protected nextUniqueId: number = 0;

    refCount: {[id: number]: number} = {};
    changeTrees: {[refId: number]: ChangeTree} = {};

    // all changes
    allChanges: ChangeTreeList = createChangeTreeList();
    allFilteredChanges: ChangeTreeList = createChangeTreeList();// TODO: do not initialize it if filters are not used

    // pending changes to be encoded
    changes: ChangeTreeList = createChangeTreeList();
    filteredChanges: ChangeTreeList = createChangeTreeList();// TODO: do not initialize it if filters are not used

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
            // Find the node and move it to end
            let current = this.filteredChanges.next;
            while (current) {
                if (current.changeTree === changeTree) {
                    moveToEndOfChangeTreeList(this.filteredChanges, current);
                    break;
                }
                current = current.next;
            }
        } else {
            // Find the node and move it to end
            let current = this.changes.next;
            while (current) {
                if (current.changeTree === changeTree) {
                    moveToEndOfChangeTreeList(this.changes, current);
                    break;
                }
                current = current.next;
            }
        }
    }

    protected removeChangeFromChangeSet(changeSetName: "allChanges" | "changes" | "filteredChanges" | "allFilteredChanges", changeTree: ChangeTree) {
        const changeSet = this[changeSetName];
        const node = changeTree[changeSetName].queueRootNode;

        if (node && node.changeTree === changeTree) {
            // Remove the node from the linked list
            if (node.prev) {
                node.prev.next = node.next;
            } else {
                changeSet.next = node.next;
            }

            if (node.next) {
                node.next.prev = node.prev;
            } else {
                changeSet.tail = node.prev;
            }

            changeSet.length--;

            // Clear ChangeTree reference
            changeTree[changeSetName].queueRootNode = undefined;
            return true;
        }

        return false;
    }

    clear() {
        this.changes = createChangeTreeList();
    }
}
