import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { ChangeTree, setOperationAtIndex, ChangeTreeList, createChangeTreeList, ChangeSetName, Ref } from "./ChangeTree";

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

        // console.log("ADD", { refId: changeTree.refId, refCount: this.refCount[changeTree.refId] });

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

            changeTree.forEachChild((child, _) => {
                if (child.removeParent(changeTree.ref)) {
                    if ((
                        child.parentChain === undefined || // no parent, remove it
                        (child.parentChain && this.refCount[child.refId] > 1) // parent is still in use, but has more than one reference, remove it
                    )) {
                        this.remove(child);

                    } else if (child.parentChain) {
                        // re-assigning a child of the same root, move it to the end
                        this.moveToEndOfChanges(child);
                    }
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
            this.moveToEndOfChanges(changeTree);
            changeTree.forEachChild((child, _) => this.moveToEndOfChanges(child));
        }

        return refCount;
    }

    moveToEndOfChanges(changeTree: ChangeTree) {
        if (changeTree.filteredChanges) {
            this.moveToEndOfChangeTreeList("filteredChanges", changeTree);
            this.moveToEndOfChangeTreeList("allFilteredChanges", changeTree);
        } else {
            this.moveToEndOfChangeTreeList("changes", changeTree);
            this.moveToEndOfChangeTreeList("allChanges", changeTree);
        }
    }

    moveToEndOfChangeTreeList(changeSetName: ChangeSetName, changeTree: ChangeTree): void {
        const changeSet = this[changeSetName];
        const node = changeTree[changeSetName].queueRootNode;
        if (!node || node === changeSet.tail) return;

        // Remove from current position
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

        // Add to end
        node.prev = changeSet.tail;
        node.next = undefined;

        if (changeSet.tail) {
            changeSet.tail.next = node;
        } else {
            changeSet.next = node;
        }

        changeSet.tail = node;
    }

    protected removeChangeFromChangeSet(changeSetName: ChangeSetName, changeTree: ChangeTree) {
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
}
