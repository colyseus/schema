import { OPERATION } from "../encoding/spec.js";
import { TypeContext } from "../types/TypeContext.js";
import { ChangeTree, setOperationAtIndex, ChangeTreeList, createChangeTreeList, ChangeSetName, type ChangeTreeNode } from "./ChangeTree.js";
import { $changes, $refId } from "../types/symbols.js";

export class Root {
    protected nextUniqueId: number = 0;

    refCount: {[id: number]: number} = {};
    changeTrees: {[refId: number]: ChangeTree} = {};

    // all changes
    allChanges: ChangeTreeList = createChangeTreeList();
    allFilteredChanges: ChangeTreeList;

    // pending changes to be encoded
    changes: ChangeTreeList = createChangeTreeList();
    filteredChanges: ChangeTreeList;

    constructor(public types: TypeContext, startRefId: number = 0) {
        this.nextUniqueId = startRefId;
        if (types.hasFilters) {
            this.allFilteredChanges = createChangeTreeList();
            this.filteredChanges = createChangeTreeList();
        }
    }

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    add(changeTree: ChangeTree) {
        const ref = changeTree.ref;

        // Assign unique `refId` to ref if it doesn't have one yet.
        if (ref[$refId] === undefined) {
            Object.defineProperty(ref, $refId, {
                value: this.getNextUniqueId(),
                enumerable: false,
                writable: true
            });
        }

        const refId = ref[$refId];

        const isNewChangeTree = (this.changeTrees[refId] === undefined);
        if (isNewChangeTree) { this.changeTrees[refId] = changeTree; }

        const previousRefCount = this.refCount[refId];
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

        this.refCount[refId] = (previousRefCount || 0) + 1;

        // console.log("ADD", { refId, ref: ref.constructor.name, refCount: this.refCount[refId], isNewChangeTree });

        return isNewChangeTree;
    }

    remove(changeTree: ChangeTree) {
        const refId = changeTree.ref[$refId];
        const refCount = (this.refCount[refId]) - 1;

        // console.log("REMOVE", { refId, ref: changeTree.ref.constructor.name, refCount, needRemove: refCount <= 0 });

        if (refCount <= 0) {
            //
            // Only remove "root" reference if it's the last reference
            //
            changeTree.root = undefined;
            delete this.changeTrees[refId];

            this.removeChangeFromChangeSet("allChanges", changeTree);
            this.removeChangeFromChangeSet("changes", changeTree);

            if (changeTree.filteredChanges) {
                this.removeChangeFromChangeSet("allFilteredChanges", changeTree);
                this.removeChangeFromChangeSet("filteredChanges", changeTree);
            }

            this.refCount[refId] = 0;

            changeTree.forEachChild((child, _) => {
                if (child.removeParent(changeTree.ref)) {
                    if ((
                        child.parentRef === undefined || // no parent, remove it
                        (child.parentRef && this.refCount[child.ref[$refId]] > 0) // parent is still in use, but has more than one reference, remove it
                    )) {
                        this.remove(child);

                    } else if (child.parentRef) {
                        // re-assigning a child of the same root, move it next to parent
                        this.moveNextToParent(child);
                    }
                }
            });

        } else {
            this.refCount[refId] = refCount;

            //
            // When losing a reference to an instance, it is best to move the
            // ChangeTree next to its parent in the encoding queue.
            //
            // This way, at decoding time, the instance that contains the
            // ChangeTree will be available before the ChangeTree itself. If the
            // containing instance is not available, the Decoder will throw
            // "refId not found" error.
            //
            this.recursivelyMoveNextToParent(changeTree);
        }

        return refCount;
    }

    recursivelyMoveNextToParent(changeTree: ChangeTree) {
        this.moveNextToParent(changeTree);
        changeTree.forEachChild((child, _) => this.recursivelyMoveNextToParent(child));
    }

    moveNextToParent(changeTree: ChangeTree) {
        if (changeTree.filteredChanges) {
            this.moveNextToParentInChangeTreeList("filteredChanges", changeTree);
            this.moveNextToParentInChangeTreeList("allFilteredChanges", changeTree);
        } else {
            this.moveNextToParentInChangeTreeList("changes", changeTree);
            this.moveNextToParentInChangeTreeList("allChanges", changeTree);
        }
    }

    moveNextToParentInChangeTreeList(changeSetName: ChangeSetName, changeTree: ChangeTree): void {
        const changeSet = this[changeSetName];
        const node = changeTree.getQueueNode(changeSetName);
        if (!node) return;

        // Find the parent in the linked list
        const parent = changeTree.parent;
        if (!parent || !parent[$changes]) return;

        const parentNode = parent[$changes].getQueueNode(changeSetName);
        if (!parentNode || parentNode === node) return;

        // Check if child is already after parent by walking from parent
        let cursor = parentNode.next;
        while (cursor) {
            if (cursor === node) return; // already after parent
            cursor = cursor.next;
        }
        // If we reach here, node is before parent — need to move

        // Child is before parent, so we need to move it after parent
        // This maintains decoding order (parent before child)

        // Remove node from current position
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

        // Insert node right after parent
        node.prev = parentNode;
        node.next = parentNode.next;

        if (parentNode.next) {
            parentNode.next.prev = node;
        } else {
            changeSet.tail = node;
        }

        parentNode.next = node;
    }

    public enqueueChangeTree(
        changeTree: ChangeTree,
        changeSet: 'changes' | 'filteredChanges' | 'allFilteredChanges' | 'allChanges',
        queueRootNode = changeTree.getQueueNode(changeSet)
    ) {
        // skip
        if (queueRootNode) { return; }

        // Add to linked list if not already present
        changeTree.setQueueNode(changeSet, this.addToChangeTreeList(this[changeSet], changeTree));
    }

    protected addToChangeTreeList(list: ChangeTreeList, changeTree: ChangeTree): ChangeTreeNode {
        const node: ChangeTreeNode = {
            changeTree,
            next: undefined,
            prev: undefined,
            position: 0
        };

        if (!list.next) {
            list.next = node;
            list.tail = node;
        } else {
            node.prev = list.tail;
            list.tail!.next = node;
            list.tail = node;
        }

        return node;
    }

    public removeChangeFromChangeSet(changeSetName: ChangeSetName, changeTree: ChangeTree) {
        const changeSet = this[changeSetName];
        const node = changeTree.getQueueNode(changeSetName);

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

            // Clear ChangeTree reference
            changeTree.setQueueNode(changeSetName, undefined);
            return true;
        }

        return false;
    }
}
