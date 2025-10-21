import { OPERATION } from "../encoding/spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refTypeFieldIndexes, $viewFieldIndexes, type $deleteByIndex } from "../types/symbols";

import type { MapSchema } from "../types/custom/MapSchema";
import type { ArraySchema } from "../types/custom/ArraySchema";
import type { CollectionSchema } from "../types/custom/CollectionSchema";
import type { SetSchema } from "../types/custom/SetSchema";

import { Root } from "./Root";
import { Metadata } from "../Metadata";
import type { EncodeOperation } from "./EncodeOperation";
import type { DecodeOperation } from "../decoder/DecodeOperation";

declare global {
    interface Object {
        // FIXME: not a good practice to extend globals here
        [$changes]?: ChangeTree;
        [$encoder]?: EncodeOperation,
        [$decoder]?: DecodeOperation,
    }
}

export interface IRef {
    [$changes]?: ChangeTree;
    [$getByIndex]?: (index: number, isEncodeAll?: boolean) => any;
    [$deleteByIndex]?: (index: number) => void;
}

export type Ref = Schema
    | ArraySchema
    | MapSchema
    | CollectionSchema
    | SetSchema;

export type ChangeSetName = "changes"
    | "allChanges"
    | "filteredChanges"
    | "allFilteredChanges";

export interface IndexedOperations {
    [index: number]: OPERATION;
}

// Linked list node for change trees
export interface ChangeTreeNode {
    changeTree: ChangeTree;
    next?: ChangeTreeNode;
    prev?: ChangeTreeNode;
    position: number; // Cached position in the linked list for O(1) lookup
}

// Linked list for change trees
export interface ChangeTreeList {
    next?: ChangeTreeNode;
    tail?: ChangeTreeNode;
}

export interface ChangeSet {
    // field index -> operation index
    indexes: { [index: number]: number };
    operations: number[];
    queueRootNode?: ChangeTreeNode; // direct reference to ChangeTreeNode in the linked list
}

function createChangeSet(queueRootNode?: ChangeTreeNode): ChangeSet {
    return { indexes: {}, operations: [], queueRootNode };
}

// Linked list helper functions
export function createChangeTreeList(): ChangeTreeList {
    return { next: undefined, tail: undefined };
}

export function setOperationAtIndex(changeSet: ChangeSet, index: number) {
    const operationsIndex = changeSet.indexes[index];
    if (operationsIndex === undefined) {
        changeSet.indexes[index] = changeSet.operations.push(index) - 1;
    } else {
        changeSet.operations[operationsIndex] = index;
    }
}

export function deleteOperationAtIndex(changeSet: ChangeSet, index: number | string) {
    let operationsIndex = changeSet.indexes[index as any as number];
    if (operationsIndex === undefined) {
        //
        // if index is not found, we need to find the last operation
        // FIXME: this is not very efficient
        //
        // > See "should allow consecutive splices (same place)" tests
        //
        operationsIndex = Object.values(changeSet.indexes).at(-1);
        index = Object.entries(changeSet.indexes).find(([_, value]) => value === operationsIndex)?.[0];
    }
    changeSet.operations[operationsIndex] = undefined;
    delete changeSet.indexes[index as any as number];
}

export function debugChangeSet(label: string, changeSet: ChangeSet) {
    let indexes: string[] = [];
    let operations: string[] = [];

    for (const index in changeSet.indexes) {
        indexes.push(`\t${index} => [${changeSet.indexes[index]}]`);
    }

    for (let i = 0; i < changeSet.operations.length; i++) {
        const index = changeSet.operations[i];
        if (index !== undefined) {
            operations.push(`\t[${i}] => ${index}`);
        }
    }

    console.log(`${label} =>\nindexes (${Object.keys(changeSet.indexes).length}) {`);
    console.log(indexes.join("\n"), "\n}");
    console.log(`operations (${changeSet.operations.filter(op => op !== undefined).length}) {`);
    console.log(operations.join("\n"), "\n}");
}

export interface ParentChain {
    ref: Ref;
    index: number;
    next?: ParentChain;
}

export class ChangeTree<T extends Ref = any> {
    ref: T;
    refId: number;
    metadata: Metadata;

    root?: Root;
    parentChain?: ParentChain; // Linked list for tracking parents

    /**
     * Whether this structure is parent of a filtered structure.
     */
    isFiltered: boolean = false;
    isVisibilitySharedWithParent?: boolean; // See test case: 'should not be required to manually call view.add() items to child arrays without @view() tag'

    indexedOperations: IndexedOperations = {};

    //
    // TODO:
    //   try storing the index + operation per item.
    //   example: 1024 & 1025 => ADD, 1026 => DELETE
    //
    // => https://chatgpt.com/share/67107d0c-bc20-8004-8583-83b17dd7c196
    //
    changes: ChangeSet = { indexes: {}, operations: [] };
    allChanges: ChangeSet = { indexes: {}, operations: [] };
    filteredChanges: ChangeSet;
    allFilteredChanges: ChangeSet;

    indexes: { [index: string]: any }; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)

    /**
     * Is this a new instance? Used on ArraySchema to determine OPERATION.MOVE_AND_ADD operation.
     */
    isNew = true;

    constructor(ref: T) {
        this.ref = ref;
        this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

        //
        // Does this structure have "filters" declared?
        //
        if (this.metadata?.[$viewFieldIndexes]) {
            this.allFilteredChanges = { indexes: {}, operations: [] };
            this.filteredChanges = { indexes: {}, operations: [] };
        }
    }

    setRoot(root: Root) {
        this.root = root;

        const isNewChangeTree = this.root.add(this);

        this.checkIsFiltered(this.parent, this.parentIndex, isNewChangeTree);

        // Recursively set root on child structures
        if (isNewChangeTree) {
            this.forEachChild((child, _) => {
                if (child.root !== root) {
                    child.setRoot(root);
                } else {
                    root.add(child); // increment refCount
                }
            });
        }
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.addParent(parent, parentIndex);

        // avoid setting parents with empty `root`
        if (!root) { return; }

        const isNewChangeTree = root.add(this);

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;
            this.checkIsFiltered(parent, parentIndex, isNewChangeTree);
        }

        // assign same parent on child structures
        if (isNewChangeTree) {
            //
            // assign same parent on child structures
            //
            this.forEachChild((child, index) => {
                if (child.root === root) {
                    //
                    // re-assigning a child of the same root, move it next to parent
                    // so encoding order is preserved
                    //
                    root.add(child);
                    root.moveNextToParent(child);
                    return;
                }
                child.setParent(this.ref, root, index);
            });
        }
    }

    forEachChild(callback: (change: ChangeTree, at: any) => void) {
        //
        // assign same parent on child structures
        //
        if ((this.ref as any)[$childType]) {
            if (typeof ((this.ref as any)[$childType]) !== "string") {
                // MapSchema / ArraySchema, etc.
                for (const [key, value] of (this.ref as MapSchema).entries()) {
                    if (!value) { continue; } // sparse arrays can have undefined values
                    callback(value[$changes], this.indexes?.[key] ?? key);
                };
            }

        } else {
            for (const index of this.metadata?.[$refTypeFieldIndexes] ?? []) {
                const field = this.metadata[index as any as number];
                const value = this.ref[field.name as keyof Ref];
                if (!value) { continue; }
                callback(value[$changes], index);
            }
        }
    }

    operation(op: OPERATION) {
        // operations without index use negative values to represent them
        // this is checked during .encode() time.
        if (this.filteredChanges !== undefined) {
            this.filteredChanges.operations.push(-op);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            this.changes.operations.push(-op);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const isFiltered = this.isFiltered || (this.metadata?.[index]?.tag !== undefined);
        const changeSet = (isFiltered)
            ? this.filteredChanges
            : this.changes;

        const previousOperation = this.indexedOperations[index];
        if (!previousOperation || previousOperation === OPERATION.DELETE) {
            const op = (!previousOperation)
                ? operation
                : (previousOperation === OPERATION.DELETE)
                    ? OPERATION.DELETE_AND_ADD
                    : operation
            //
            // TODO: are DELETE operations being encoded as ADD here ??
            //
            this.indexedOperations[index] = op;
        }

        setOperationAtIndex(changeSet, index);

        if (isFiltered) {
            setOperationAtIndex(this.allFilteredChanges, index);

            if (this.root) {
                this.root.enqueueChangeTree(this, 'filteredChanges');
                this.root.enqueueChangeTree(this, 'allFilteredChanges');
            }

        } else {
            setOperationAtIndex(this.allChanges, index);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    shiftChangeIndexes(shiftIndex: number) {
        //
        // Used only during:
        //
        // - ArraySchema#unshift()
        //
        const changeSet = (this.isFiltered)
            ? this.filteredChanges
            : this.changes;

        const newIndexedOperations: any = {};
        const newIndexes: { [index: number]: number } = {};
        for (const index in this.indexedOperations) {
            newIndexedOperations[Number(index) + shiftIndex] = this.indexedOperations[index];
            newIndexes[Number(index) + shiftIndex] = changeSet.indexes[index];
        }
        this.indexedOperations = newIndexedOperations;
        changeSet.indexes = newIndexes;

        changeSet.operations = changeSet.operations.map((index) => index + shiftIndex);
    }

    shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0) {
        //
        // Used only during:
        //
        // - ArraySchema#splice()
        //
        if (this.filteredChanges !== undefined) {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allFilteredChanges);
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);

        } else {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);
        }
    }

    private _shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0, changeSet: ChangeSet) {
        const newIndexes: { [index: number]: number } = {};
        let newKey = 0;
        for (const key in changeSet.indexes) {
            newIndexes[newKey++] = changeSet.indexes[key];
        }
        changeSet.indexes = newIndexes;

        for (let i = 0; i < changeSet.operations.length; i++) {
            const index = changeSet.operations[i];
            if (index > startIndex) {
                changeSet.operations[i] = index + shiftIndex;
            }
        }
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex: number = index) {
        this.indexedOperations[index] = operation;

        if (this.filteredChanges !== undefined) {
            setOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            setOperationAtIndex(this.filteredChanges, index);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            setOperationAtIndex(this.allChanges, allChangesIndex);
            setOperationAtIndex(this.changes, index);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    getType(index?: number) {
        return (
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            (this.ref as any)[$childType] || // ArraySchema | MapSchema | SetSchema | CollectionSchema
            this.metadata[index].type // Schema
        );
    }

    getChange(index: number) {
        return this.indexedOperations[index];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number, isEncodeAll: boolean = false) {
        //
        // `isEncodeAll` param is only used by ArraySchema
        //
        return (this.ref as any)[$getByIndex](index, isEncodeAll);
    }

    delete(index: number, operation?: OPERATION, allChangesIndex = index) {
        if (index === undefined) {
            try {
                throw new Error(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index '${index}'`);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        const changeSet = (this.filteredChanges !== undefined)
            ? this.filteredChanges
            : this.changes;

        this.indexedOperations[index] = operation ?? OPERATION.DELETE;
        setOperationAtIndex(changeSet, index);
        deleteOperationAtIndex(this.allChanges, allChangesIndex);

        const previousValue = this.getValue(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            //
            // FIXME: this.root is "undefined"
            //
            // This method is being called at decoding time when a DELETE operation is found.
            //
            // - This is due to using the concrete Schema class at decoding time.
            // - "Reflected" structures do not have this problem.
            //
            // (The property descriptors should NOT be used at decoding time. only at encoding time.)
            //
            this.root?.remove(previousValue[$changes]);
        }

        //
        // FIXME: this is looking a ugly and repeated
        //
        if (this.filteredChanges !== undefined) {
            deleteOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            this.root?.enqueueChangeTree(this, 'changes');
        }

        return previousValue;
    }

    endEncode(changeSetName: ChangeSetName) {
        this.indexedOperations = {};

        // clear changeset
        this[changeSetName] = createChangeSet();

        // ArraySchema and MapSchema have a custom "encode end" method
        (this.ref as any)[$onEncodeEnd]?.();

        // Not a new instance anymore
        this.isNew = false;
    }

    discard(discardAll: boolean = false) {
        //
        // > MapSchema:
        //      Remove cached key to ensure ADD operations is unsed instead of
        //      REPLACE in case same key is used on next patches.
        //
        (this.ref as any)[$onEncodeEnd]?.();

        this.indexedOperations = {};
        this.changes = createChangeSet(this.changes.queueRootNode);

        if (this.filteredChanges !== undefined) {
            this.filteredChanges = createChangeSet(this.filteredChanges.queueRootNode);
        }

        if (discardAll) {
            // preserve queueRootNode references
            this.allChanges = createChangeSet(this.allChanges.queueRootNode);

            if (this.allFilteredChanges !== undefined) {
                this.allFilteredChanges = createChangeSet(this.allFilteredChanges.queueRootNode);
            }
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     * (Used in tests only)
     */
    discardAll() {
        const keys = Object.keys(this.indexedOperations);
        for (let i = 0, len = keys.length; i < len; i++) {
            const value = this.getValue(Number(keys[i]));

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        }

        this.discard();
    }

    get changed() {
        return (Object.entries(this.indexedOperations).length > 0);
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number, isNewChangeTree: boolean) {
        if (this.root.types.hasFilters) {
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this._checkFilteredByParent(parent, parentIndex);

            if (this.filteredChanges !== undefined) {
                this.root?.enqueueChangeTree(this, 'filteredChanges');

                if (isNewChangeTree) {
                    this.root?.enqueueChangeTree(this, 'allFilteredChanges');
                }
            }
        }

        if (!this.isFiltered) {
            this.root?.enqueueChangeTree(this, 'changes');

            if (isNewChangeTree) {
                this.root?.enqueueChangeTree(this, 'allChanges');
            }
        }
    }

    protected _checkFilteredByParent(parent: Ref, parentIndex: number) {
        // skip if parent is not set
        if (!parent) { return; }

        //
        // ArraySchema | MapSchema - get the child type
        // (if refType is typeof string, the parentFiltered[key] below will always be invalid)
        //
        const refType = Metadata.isValidInstance(this.ref)
            ? this.ref.constructor
            : (this.ref as any)[$childType];

        let parentChangeTree: ChangeTree;

        let parentIsCollection = !Metadata.isValidInstance(parent);
        if (parentIsCollection) {
            parentChangeTree = parent[$changes];
            parent = parentChangeTree.parent;
            parentIndex = parentChangeTree.parentIndex;

        } else {
            parentChangeTree = parent[$changes]
        }

        const parentConstructor = parent.constructor as typeof Schema;

        let key = `${this.root.types.getTypeId(refType as typeof Schema)}`;
        if (parentConstructor) {
            key += `-${this.root.types.schemas.get(parentConstructor)}`;
        }
        key += `-${parentIndex}`;

        const fieldHasViewTag = Metadata.hasViewTagAtIndex(parentConstructor?.[Symbol.metadata], parentIndex);

        this.isFiltered = parent[$changes].isFiltered // in case parent is already filtered
            || this.root.types.parentFiltered[key]
            || fieldHasViewTag;

        //
        // "isFiltered" may not be imedialely available during `change()` due to the instance not being attached to the root yet.
        // when it's available, we need to enqueue the "changes" changeset into the "filteredChanges" changeset.
        //
        if (this.isFiltered) {

            this.isVisibilitySharedWithParent = (
                parentChangeTree.isFiltered &&
                typeof (refType) !== "string" &&
                !fieldHasViewTag &&
                parentIsCollection
            );

            if (!this.filteredChanges) {
                this.filteredChanges = createChangeSet();
                this.allFilteredChanges = createChangeSet();
            }

            if (this.changes.operations.length > 0) {
                this.changes.operations.forEach((index) =>
                    setOperationAtIndex(this.filteredChanges, index));

                this.allChanges.operations.forEach((index) =>
                    setOperationAtIndex(this.allFilteredChanges, index));

                this.changes = createChangeSet();
                this.allChanges = createChangeSet();
            }
        }
    }

    /**
     * Get the immediate parent
     */
    get parent(): Ref | undefined {
        return this.parentChain?.ref;
    }

    /**
     * Get the immediate parent index
     */
    get parentIndex(): number | undefined {
        return this.parentChain?.index;
    }

    /**
     * Add a parent to the chain
     */
    addParent(parent: Ref, index: number) {
        // Check if this parent already exists in the chain
        if (this.hasParent((p, _) => p[$changes] === parent[$changes])) {
        // if (this.hasParent((p, i) => p[$changes] === parent[$changes] && i === index)) {
            this.parentChain.index = index;
            return;
        }

        this.parentChain = {
            ref: parent,
            index,
            next: this.parentChain
        };
    }

    /**
     * Remove a parent from the chain
     * @param parent - The parent to remove
     * @returns true if parent was removed
     */
    removeParent(parent: Ref = this.parent): boolean {
        let current = this.parentChain;
        let previous = null;
        while (current) {
            //
            // FIXME: it is required to check against `$changes` here because
            // ArraySchema is instance of Proxy
            //
            if (current.ref[$changes] === parent[$changes]) {
                if (previous) {
                    previous.next = current.next;
                } else {
                    this.parentChain = current.next;
                }
                return true;
            }
            previous = current;
            current = current.next;
        }
        return this.parentChain === undefined;
    }

    /**
     * Find a specific parent in the chain
     */
    findParent(predicate: (parent: Ref, index: number) => boolean): ParentChain | undefined {
        let current = this.parentChain;
        while (current) {
            if (predicate(current.ref, current.index)) {
                return current;
            }
            current = current.next;
        }
        return undefined;
    }

    /**
     * Check if this ChangeTree has a specific parent
     */
    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return this.findParent(predicate) !== undefined;
    }

    /**
     * Get all parents as an array (for debugging/testing)
     */
    getAllParents(): Array<{ ref: Ref, index: number }> {
        const parents: Array<{ ref: Ref, index: number }> = [];
        let current = this.parentChain;
        while (current) {
            parents.push({ ref: current.ref, index: current.index });
            current = current.next;
        }
        return parents;
    }

}
