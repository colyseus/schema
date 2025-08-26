import { OPERATION } from "../encoding/spec";
import { TypeContext } from "../types/TypeContext";
import { ChangeTree, setOperationAtIndex, ChangeTreeList, createChangeTreeList, ChangeSetName, type ChangeTreeNode } from "./ChangeTree";
import { $changes } from "../types/symbols";

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

        // console.log("ADD", { refId: changeTree.refId, ref: changeTree.ref.constructor.name, refCount: this.refCount[changeTree.refId], isNewChangeTree });

        return isNewChangeTree;
    }

    remove(changeTree: ChangeTree) {
        const refCount = (this.refCount[changeTree.refId]) - 1;

        // console.log("REMOVE", { refId: changeTree.refId, ref: changeTree.ref.constructor.name, refCount, needRemove: refCount <= 0 });

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
                        (child.parentChain && this.refCount[child.refId] > 0) // parent is still in use, but has more than one reference, remove it
                    )) {
                        this.remove(child);

                    } else if (child.parentChain) {
                        // re-assigning a child of the same root, move it next to parent
                        this.recursivelyMoveNextToParent(child);
                    }
                }
            });

        } else {
            this.refCount[changeTree.refId] = refCount;

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
        const node = changeTree[changeSetName].queueRootNode;
        if (!node) return;

        // Find the parent in the linked list
        const parent = changeTree.parent;
        if (!parent || !parent[$changes]) return;

        const parentNode = parent[$changes][changeSetName]?.queueRootNode;
        if (!parentNode || parentNode === node) return;

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

    // moveSubtreeToEndOfChangeTreeList(changeSetName: ChangeSetName, changeTree: ChangeTree): void {
    //     // Find the contiguous range of nodes that belong to this subtree
    //     const subtreeRange = this.findSubtreeRange(changeTree, changeSetName);
    //     if (!subtreeRange) return;

    //     const changeSet = this[changeSetName];
    //     const { firstNode, lastNode } = subtreeRange;

    //     // If the last node is already at the tail, no need to move
    //     if (lastNode === changeSet.tail) return;

    //     // Remove the entire subtree range from current position
    //     if (firstNode.prev) {
    //         firstNode.prev.next = lastNode.next;
    //     } else {
    //         changeSet.next = lastNode.next;
    //     }

    //     if (lastNode.next) {
    //         lastNode.next.prev = firstNode.prev;
    //     } else {
    //         changeSet.tail = firstNode.prev;
    //     }

    //     // Add the entire subtree to the end
    //     firstNode.prev = changeSet.tail;
    //     lastNode.next = undefined;

    //     if (changeSet.tail) {
    //         changeSet.tail.next = firstNode;
    //     } else {
    //         changeSet.next = firstNode;
    //     }

    //     changeSet.tail = lastNode;
    // }

    // private findSubtreeRange(changeTree: ChangeTree, changeSetName: ChangeSetName): { firstNode: ChangeTreeNode, lastNode: ChangeTreeNode } | null {
    //     const rootNode = changeTree[changeSetName].queueRootNode;
    //     if (!rootNode) return null;

    //     // Collect all refIds that belong to this subtree
    //     const subtreeRefIds = new Set<number>();
    //     this.collectSubtreeRefIds(changeTree, subtreeRefIds);

    //     // Find the first and last nodes in the linked list that belong to this subtree
    //     let firstNode: ChangeTreeNode | null = null;
    //     let lastNode: ChangeTreeNode | null = null;
    //     let current = this[changeSetName].next;

    //     while (current) {
    //         if (subtreeRefIds.has(current.changeTree.refId)) {
    //             if (!firstNode) firstNode = current;
    //             lastNode = current;
    //         }
    //         current = current.next;
    //     }

    //     return firstNode && lastNode ? { firstNode, lastNode } : null;
    // }

    // private collectSubtreeRefIds(changeTree: ChangeTree, result: Set<number>): void {
    //     result.add(changeTree.refId);

    //     // Collect children recursively
    //     changeTree.forEachChild((child, _) => {
    //         this.collectSubtreeRefIds(child, result);
    //     });
    // }

    public enqueueChangeTree(
        changeTree: ChangeTree,
        changeSet: 'changes' | 'filteredChanges' | 'allFilteredChanges' | 'allChanges',
        queueRootNode = changeTree[changeSet].queueRootNode
    ) {
        // skip
        if (queueRootNode) { return; }

        // Add to linked list if not already present
        changeTree[changeSet].queueRootNode = this.addToChangeTreeList(this[changeSet], changeTree);
    }

    protected addToChangeTreeList(list: ChangeTreeList, changeTree: ChangeTree): ChangeTreeNode {
        const node: ChangeTreeNode = { changeTree, next: undefined, prev: undefined };

        if (!list.next) {
            list.next = node;
            list.tail = node;
        } else {
            node.prev = list.tail;
            list.tail!.next = node;
            list.tail = node;
        }

        list.length++;

        return node;
    }

    public removeChangeFromChangeSet(changeSetName: ChangeSetName, changeTree: ChangeTree) {
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
