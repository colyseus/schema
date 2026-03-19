import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $decoder, $numFields, $onEncodeEnd, $encoder, $getByIndex, $refId, $refTypeFieldIndexes, $viewFieldIndexes, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import type { DecodeOperation } from "../decoder/DecodeOperation.js";

declare global {
    interface Object {
        // FIXME: not a good practice to extend globals here
        [$changes]?: ChangeTree;
        // [$refId]?: number;
        [$encoder]?: EncodeOperation,
        [$decoder]?: DecodeOperation,
    }
}

export interface IRef {
    // FIXME: we only commented this out to allow mixing @colyseus/schema bundled types with server types in Cocos Creator
    // [$changes]?: ChangeTree;
    [$refId]?: number;
    [$getByIndex]?: (index: number, isEncodeAll?: boolean) => any;
    [$deleteByIndex]?: (index: number) => void;
}

export type Ref = Schema | ArraySchema | MapSchema | CollectionSchema | SetSchema;

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
}

function createChangeSet(): ChangeSet {
    return { indexes: {}, operations: [] };
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
    metadata: Metadata;

    /**
     * Schema types (bounded 0-63 fields) use typed arrays + bitfields.
     * Collection types (unbounded) use plain objects + ChangeSet.
     */
    isSchemaType: boolean;

    root?: Root;
    parentChain?: ParentChain; // Linked list for tracking parents

    /**
     * Whether this structure is parent of a filtered structure.
     */
    isFiltered: boolean = false;
    isVisibilitySharedWithParent?: boolean; // See test case: 'should not be required to manually call view.add() items to child arrays without @view() tag'

    //
    // Schema-only: typed array for field operations (0 = no change)
    // OPERATION.REPLACE (0) is never stored for Schema types, so 0 is safe as sentinel.
    //
    operationsByIndex: Uint8Array;

    //
    // Schema-only: bitfield change tracking
    // changedBits/changedBitsHigh: pending changes for current encode cycle (fields 0-31 / 32-63)
    // allChangedBits/allChangedBitsHigh: all-time changes for encodeAll
    //
    changedBits: number = 0;
    changedBitsHigh: number = 0;
    allChangedBits: number = 0;
    allChangedBitsHigh: number = 0;

    // Schema-only: filtered bitfield variants (only when @view() tags exist)
    filteredBits: number = 0;
    filteredBitsHigh: number = 0;
    allFilteredBits: number = 0;
    allFilteredBitsHigh: number = 0;

    // Schema-only: equivalent of `filteredChanges !== undefined` for collections
    hasFilteredEncoding: boolean = false;

    //
    // Collection-only: plain object operations + ChangeSet tracking
    //
    indexedOperations: IndexedOperations;
    changes: ChangeSet;
    allChanges: ChangeSet;
    filteredChanges: ChangeSet;
    allFilteredChanges: ChangeSet;

    //
    // Queue nodes for linked list membership (shared for both Schema and Collection)
    //
    changesQueueNode?: ChangeTreeNode;
    allChangesQueueNode?: ChangeTreeNode;
    filteredChangesQueueNode?: ChangeTreeNode;
    allFilteredChangesQueueNode?: ChangeTreeNode;

    indexes: { [index: string]: any }; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)

    /**
     * Is this a new instance? Used on ArraySchema to determine OPERATION.MOVE_AND_ADD operation.
     */
    isNew = true;

    constructor(ref: T) {
        this.ref = ref;
        this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

        const numFields = this.metadata?.[$numFields];
        this.isSchemaType = numFields !== undefined && numFields <= 63;

        if (this.isSchemaType) {
            // Schema: use typed array for operations
            this.operationsByIndex = new Uint8Array(numFields + 1);

            if (this.metadata[$viewFieldIndexes]) {
                this.hasFilteredEncoding = true;
            }
        } else {
            // Collection: use plain objects
            this.indexedOperations = {};
            this.changes = { indexes: {}, operations: [] };
            this.allChanges = { indexes: {}, operations: [] };

            //
            // Does this structure have "filters" declared?
            //
            if (this.metadata?.[$viewFieldIndexes]) {
                this.allFilteredChanges = { indexes: {}, operations: [] };
                this.filteredChanges = { indexes: {}, operations: [] };
            }
        }
    }

    getQueueNode(changeSetName: ChangeSetName): ChangeTreeNode | undefined {
        switch (changeSetName) {
            case 'changes': return this.changesQueueNode;
            case 'allChanges': return this.allChangesQueueNode;
            case 'filteredChanges': return this.filteredChangesQueueNode;
            case 'allFilteredChanges': return this.allFilteredChangesQueueNode;
        }
    }

    setQueueNode(changeSetName: ChangeSetName, node: ChangeTreeNode | undefined): void {
        switch (changeSetName) {
            case 'changes': this.changesQueueNode = node; break;
            case 'allChanges': this.allChangesQueueNode = node; break;
            case 'filteredChanges': this.filteredChangesQueueNode = node; break;
            case 'allFilteredChanges': this.allFilteredChangesQueueNode = node; break;
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
                const indexes = this.indexes;
                (this.ref as MapSchema).forEach((value: any, key: any) => {
                    if (!value) { return; } // sparse arrays can have undefined values
                    callback(value[$changes], indexes?.[key] ?? key);
                });
            }

        } else {
            const refTypeIndexes = this.metadata?.[$refTypeFieldIndexes];
            if (refTypeIndexes) {
                for (let i = 0, len = refTypeIndexes.length; i < len; i++) {
                    const index = refTypeIndexes[i];
                    const field = this.metadata[index as any as number];
                    const value = this.ref[field.name as keyof Ref];
                    if (!value) { continue; }
                    callback(value[$changes], index);
                }
            }
        }
    }

    operation(op: OPERATION) {
        // operations without index use negative values to represent them
        // this is checked during .encode() time.
        // NOTE: only used by collection types (CLEAR, REVERSE)
        if (this.filteredChanges !== undefined) {
            this.filteredChanges.operations.push(-op);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            this.changes.operations.push(-op);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        if (this.isSchemaType) {
            //
            // Schema path: typed array + bitfields
            //
            const previousOperation = this.operationsByIndex[index];
            if (!previousOperation || previousOperation === OPERATION.DELETE) {
                this.operationsByIndex[index] = (!previousOperation)
                    ? operation
                    : OPERATION.DELETE_AND_ADD;
            }

            const isFiltered = this.isFiltered || this.metadata[index]?.tag !== undefined;

            if (isFiltered) {
                if (index < 32) {
                    this.filteredBits |= (1 << index);
                    this.allFilteredBits |= (1 << index);
                } else {
                    this.filteredBitsHigh |= (1 << (index - 32));
                    this.allFilteredBitsHigh |= (1 << (index - 32));
                }

                const root = this.root;
                if (root) {
                    root.enqueueChangeTree(this, 'filteredChanges');
                    root.enqueueChangeTree(this, 'allFilteredChanges');
                }

            } else {
                if (index < 32) {
                    this.changedBits |= (1 << index);
                    this.allChangedBits |= (1 << index);
                } else {
                    this.changedBitsHigh |= (1 << (index - 32));
                    this.allChangedBitsHigh |= (1 << (index - 32));
                }
                if (this.root) { this.root.enqueueChangeTree(this, 'changes'); }
            }

        } else {
            //
            // Collection path: plain objects + ChangeSet
            //
            const isFiltered = this.isFiltered || (this.metadata !== undefined && this.metadata[index]?.tag !== undefined);
            const changeSet = (isFiltered)
                ? this.filteredChanges
                : this.changes;

            const previousOperation = this.indexedOperations[index];
            if (!previousOperation || previousOperation === OPERATION.DELETE) {
                this.indexedOperations[index] = (!previousOperation)
                    ? operation
                    : OPERATION.DELETE_AND_ADD;
            }

            setOperationAtIndex(changeSet, index);

            if (isFiltered) {
                setOperationAtIndex(this.allFilteredChanges, index);

                const root = this.root;
                if (root) {
                    root.enqueueChangeTree(this, 'filteredChanges');
                    root.enqueueChangeTree(this, 'allFilteredChanges');
                }

            } else {
                setOperationAtIndex(this.allChanges, index);
                if (this.root) { this.root.enqueueChangeTree(this, 'changes'); }
            }
        }
    }

    shiftChangeIndexes(shiftIndex: number) {
        //
        // Used only during:
        //
        // - ArraySchema#unshift()
        //
        // NOTE: collection-only, never called for Schema types
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
        // NOTE: collection-only, never called for Schema types
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
        // NOTE: only used by collection types
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


    getChange(index: number): OPERATION | undefined {
        if (this.isSchemaType) {
            const op = this.operationsByIndex[index];
            return op !== 0 ? op as OPERATION : undefined;
        }
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

        if (this.isSchemaType) {
            //
            // Schema path
            //
            this.operationsByIndex[index] = operation ?? OPERATION.DELETE;

            // Clear from allChangedBits (the field is being deleted)
            if (index < 32) {
                this.allChangedBits &= ~(1 << index);
            } else {
                this.allChangedBitsHigh &= ~(1 << (index - 32));
            }

            const previousValue = this.getValue(index);

            // remove `root` reference
            if (previousValue && previousValue[$changes]) {
                this.root?.remove(previousValue[$changes]);
            }

            if (this.hasFilteredEncoding) {
                if (index < 32) {
                    this.filteredBits |= (1 << index);
                    this.allFilteredBits &= ~(1 << index);
                } else {
                    this.filteredBitsHigh |= (1 << (index - 32));
                    this.allFilteredBitsHigh &= ~(1 << (index - 32));
                }
                this.root?.enqueueChangeTree(this, 'filteredChanges');

            } else {
                if (index < 32) {
                    this.changedBits |= (1 << index);
                } else {
                    this.changedBitsHigh |= (1 << (index - 32));
                }
                this.root?.enqueueChangeTree(this, 'changes');
            }

            return previousValue;

        } else {
            //
            // Collection path
            //
            const changeSet = (this.filteredChanges !== undefined)
                ? this.filteredChanges
                : this.changes;

            this.indexedOperations[index] = operation ?? OPERATION.DELETE;
            setOperationAtIndex(changeSet, index);
            deleteOperationAtIndex(this.allChanges, allChangesIndex);

            const previousValue = this.getValue(index);

            // remove `root` reference
            if (previousValue && previousValue[$changes]) {
                this.root?.remove(previousValue[$changes]);
            }

            if (this.filteredChanges !== undefined) {
                deleteOperationAtIndex(this.allFilteredChanges, allChangesIndex);
                this.root?.enqueueChangeTree(this, 'filteredChanges');

            } else {
                this.root?.enqueueChangeTree(this, 'changes');
            }

            return previousValue;
        }
    }

    endEncode(changeSetName: ChangeSetName) {
        if (this.isSchemaType) {
            //
            // Schema path: zero-allocation clear
            //
            this.operationsByIndex.fill(0);

            switch (changeSetName) {
                case 'changes':
                    this.changedBits = 0;
                    this.changedBitsHigh = 0;
                    break;
                case 'filteredChanges':
                    this.filteredBits = 0;
                    this.filteredBitsHigh = 0;
                    break;
                case 'allChanges':
                    this.allChangedBits = 0;
                    this.allChangedBitsHigh = 0;
                    break;
                case 'allFilteredChanges':
                    this.allFilteredBits = 0;
                    this.allFilteredBitsHigh = 0;
                    break;
            }

        } else {
            //
            // Collection path
            //
            this.indexedOperations = {};

            // clear changeset
            const cs = this[changeSetName];
            cs.indexes = {};
            cs.operations.length = 0;
        }

        // Clear queue node
        this.setQueueNode(changeSetName, undefined);

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

        if (this.isSchemaType) {
            //
            // Schema path: zero-allocation clear
            //
            this.operationsByIndex.fill(0);
            this.changedBits = 0;
            this.changedBitsHigh = 0;

            if (this.hasFilteredEncoding) {
                this.filteredBits = 0;
                this.filteredBitsHigh = 0;
            }

            if (discardAll) {
                this.allChangedBits = 0;
                this.allChangedBitsHigh = 0;

                if (this.hasFilteredEncoding) {
                    this.allFilteredBits = 0;
                    this.allFilteredBitsHigh = 0;
                }
            }

        } else {
            //
            // Collection path
            //
            this.indexedOperations = {};
            this.changes = createChangeSet();

            if (this.filteredChanges !== undefined) {
                this.filteredChanges = createChangeSet();
            }

            if (discardAll) {
                this.allChanges = createChangeSet();

                if (this.allFilteredChanges !== undefined) {
                    this.allFilteredChanges = createChangeSet();
                }
            }
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     * (Used in tests only)
     */
    discardAll() {
        if (this.isSchemaType) {
            for (let i = 0, len = this.operationsByIndex.length; i < len; i++) {
                if (this.operationsByIndex[i] !== 0) {
                    const value = this.getValue(i);
                    if (value && value[$changes]) {
                        value[$changes].discardAll();
                    }
                }
            }
        } else {
            const keys = Object.keys(this.indexedOperations);
            for (let i = 0, len = keys.length; i < len; i++) {
                const value = this.getValue(Number(keys[i]));

                if (value && value[$changes]) {
                    value[$changes].discardAll();
                }
            }
        }

        this.discard();
    }

    get changed() {
        if (this.isSchemaType) {
            return this.changedBits !== 0 || this.changedBitsHigh !== 0 ||
                   this.filteredBits !== 0 || this.filteredBitsHigh !== 0;
        }
        return (Object.entries(this.indexedOperations).length > 0);
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number, isNewChangeTree: boolean) {
        const root = this.root;

        if (root.types.hasFilters) {
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this._checkFilteredByParent(parent, parentIndex);

            if (this.isSchemaType ? this.hasFilteredEncoding : this.filteredChanges !== undefined) {
                root.enqueueChangeTree(this, 'filteredChanges');

                if (isNewChangeTree) {
                    root.enqueueChangeTree(this, 'allFilteredChanges');
                }
            }
        }

        if (!this.isFiltered) {
            root.enqueueChangeTree(this, 'changes');

            if (isNewChangeTree) {
                root.enqueueChangeTree(this, 'allChanges');
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

            if (this.isSchemaType) {
                //
                // Schema path: move changedBits to filteredBits
                //
                if (!this.hasFilteredEncoding) {
                    this.hasFilteredEncoding = true;
                }

                if (this.changedBits !== 0 || this.changedBitsHigh !== 0) {
                    this.filteredBits |= this.changedBits;
                    this.filteredBitsHigh |= this.changedBitsHigh;
                    this.allFilteredBits |= this.allChangedBits;
                    this.allFilteredBitsHigh |= this.allChangedBitsHigh;
                    this.changedBits = 0;
                    this.changedBitsHigh = 0;
                    this.allChangedBits = 0;
                    this.allChangedBitsHigh = 0;
                }

            } else {
                //
                // Collection path
                //
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
        // Fast path: check immediate parent first (most common case, avoids closure allocation)
        const parentChanges = parent[$changes];
        if (this.parentChain) {
            if (this.parentChain.ref[$changes] === parentChanges) {
                this.parentChain.index = index;
                return;
            }
            // Walk the chain only if there are more parents
            let current = this.parentChain.next;
            while (current) {
                if (current.ref[$changes] === parentChanges) {
                    // Match original behavior: update head's index
                    this.parentChain.index = index;
                    return;
                }
                current = current.next;
            }
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
