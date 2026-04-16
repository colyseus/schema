import { OPERATION } from "../encoding/spec.js";
import { TypeContext } from "../types/TypeContext.js";
import { ChangeTree, ChangeTreeList, createChangeTreeList, type ChangeTreeNode } from "./ChangeTree.js";
import { $changes, $refId } from "../types/symbols.js";

export class Root {
    protected nextUniqueId: number = 0;

    refCount: {[id: number]: number} = {};
    changeTrees: {[refId: number]: ChangeTree} = {};

    /**
     * Queue of all ChangeTrees with reliable dirty state. Per-tick encode()
     * walks this queue; per-view encodeView() walks it too (filtering at
     * emission time via tree.isFiltered + per-field @view tag).
     */
    changes: ChangeTreeList = createChangeTreeList();

    /**
     * Queue of all ChangeTrees with unreliable dirty state. Walked by
     * `Encoder.encodeUnreliable` / `encodeUnreliableView`. A tree may live
     * in both queues when the Schema has both reliable and unreliable
     * fields dirty at the same time.
     */
    unreliableChanges: ChangeTreeList = createChangeTreeList();

    constructor(public types: TypeContext, startRefId: number = 0) {
        this.nextUniqueId = startRefId;
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
            // When a ChangeTree is re-added, it means that it was previously
            // removed. Re-stage every currently-populated non-transient index
            // as a fresh ADD in the matching dirty bucket so the next encode
            // re-emits it on the correct channel.
            //
            changeTree.forEachLive((fieldIndex) => {
                if (changeTree.isFieldUnreliable(fieldIndex)) {
                    changeTree.ensureUnreliableRecorder().record(fieldIndex, OPERATION.ADD);
                } else {
                    changeTree.recorder.record(fieldIndex, OPERATION.ADD);
                }
            });
        }

        this.refCount[refId] = (previousRefCount || 0) + 1;

        return isNewChangeTree;
    }

    remove(changeTree: ChangeTree) {
        const refId = changeTree.ref[$refId];
        const refCount = (this.refCount[refId]) - 1;

        if (refCount <= 0) {
            //
            // Only remove "root" reference if it's the last reference
            //
            changeTree.root = undefined;
            delete this.changeTrees[refId];

            this.removeFromQueue(changeTree);
            this.removeFromUnreliableQueue(changeTree);

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

    moveNextToParent(changeTree: ChangeTree): void {
        if (changeTree.changesNode) {
            this._moveNextToParentInList(this.changes, changeTree, changeTree.changesNode, "changesNode");
        }
        if (changeTree.unreliableChangesNode) {
            this._moveNextToParentInList(this.unreliableChanges, changeTree, changeTree.unreliableChangesNode, "unreliableChangesNode");
        }
    }

    private _moveNextToParentInList(
        changeSet: ChangeTreeList,
        changeTree: ChangeTree,
        node: ChangeTreeNode,
        nodeField: "changesNode" | "unreliableChangesNode",
    ): void {
        const parent = changeTree.parent;
        if (!parent || !parent[$changes]) return;

        const parentNode = parent[$changes][nodeField];
        if (!parentNode || parentNode === node) return;

        // Check if child is already after parent by walking from parent
        let cursor = parentNode.next;
        while (cursor) {
            if (cursor === node) return; // already after parent
            cursor = cursor.next;
        }
        // If we reach here, node is before parent — need to move

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
        existingNode = changeTree.changesNode
    ) {
        if (existingNode) { return; }
        changeTree.changesNode = this._appendToList(this.changes, changeTree);
    }

    public enqueueUnreliable(
        changeTree: ChangeTree,
        existingNode = changeTree.unreliableChangesNode
    ) {
        if (existingNode) { return; }
        changeTree.unreliableChangesNode = this._appendToList(this.unreliableChanges, changeTree);
    }

    private _appendToList(list: ChangeTreeList, changeTree: ChangeTree): ChangeTreeNode {
        const node: ChangeTreeNode = {
            changeTree,
            next: undefined,
            prev: undefined,
            position: 0,
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

    public removeFromQueue(changeTree: ChangeTree): boolean {
        return this._removeNode(this.changes, changeTree, changeTree.changesNode, "changesNode");
    }

    public removeFromUnreliableQueue(changeTree: ChangeTree): boolean {
        return this._removeNode(this.unreliableChanges, changeTree, changeTree.unreliableChangesNode, "unreliableChangesNode");
    }

    private _removeNode(
        changeSet: ChangeTreeList,
        changeTree: ChangeTree,
        node: ChangeTreeNode | undefined,
        nodeField: "changesNode" | "unreliableChangesNode",
    ): boolean {
        if (!node || node.changeTree !== changeTree) return false;

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

        changeTree[nodeField] = undefined;
        return true;
    }
}
