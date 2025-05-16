import { OPERATION } from "../encoding/spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refTypeFieldIndexes, $viewFieldIndexes } from "../types/symbols";

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

export interface ChangeSet {
    // field index -> operation index
    indexes: { [index: number]: number };
    operations: number[];
    queueRootIndex?: number; // index of ChangeTree structure in `root.changes` or `root.filteredChanges`
}

function createChangeSet(): ChangeSet {
    return { indexes: {}, operations: [] };
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
    let operationsIndex = changeSet.indexes[index];
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
    delete changeSet.indexes[index];
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

export function enqueueChangeTree(
    root: Root,
    changeTree: ChangeTree,
    changeSet: 'changes' | 'filteredChanges' | 'allFilteredChanges',
    queueRootIndex = changeTree[changeSet].queueRootIndex
) {
    if (!root) {
        // skip
        return;

    } else if (root[changeSet][queueRootIndex] !== changeTree) {
        changeTree[changeSet].queueRootIndex = root[changeSet].push(changeTree) - 1;
    }
}

export class ChangeTree<T extends Ref=any> {
    ref: T;
    refId: number;

    root?: Root;
    parent?: Ref;
    parentIndex?: number;

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

    indexes: {[index: string]: any}; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)

    /**
     * Is this a new instance? Used on ArraySchema to determine OPERATION.MOVE_AND_ADD operation.
     */
    isNew = true;

    constructor(ref: T) {
        this.ref = ref;

        //
        // Does this structure have "filters" declared?
        //
        const metadata = ref.constructor[Symbol.metadata];
        if (metadata?.[$viewFieldIndexes]) {
            this.allFilteredChanges = { indexes: {}, operations: [] };
            this.filteredChanges = { indexes: {}, operations: [] };
        }
    }

    setRoot(root: Root) {
        this.root = root;
        this.checkIsFiltered(this.parent, this.parentIndex);

        //
        // TODO: refactor and possibly unify .setRoot() and .setParent()
        //

        // Recursively set root on child structures
        const metadata: Metadata = this.ref.constructor[Symbol.metadata];
        if (metadata) {
            metadata[$refTypeFieldIndexes]?.forEach((index) => {
                const field = metadata[index as any as number];
                const changeTree: ChangeTree = this.ref[field.name]?.[$changes];
                if (changeTree) {
                    if (changeTree.root !== root) {
                        changeTree.setRoot(root);
                    } else {
                        root.add(changeTree); // increment refCount
                    }
                }
            });

        } else if (this.ref[$childType] && typeof(this.ref[$childType]) !== "string") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                const changeTree: ChangeTree = value[$changes];
                if (changeTree.root !== root) {
                    changeTree.setRoot(root);
                } else {
                    root.add(changeTree); // increment refCount
                }
            });
        }
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.parent = parent;
        this.parentIndex = parentIndex;

        // avoid setting parents with empty `root`
        if (!root) { return; }

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;
            this.checkIsFiltered(parent, parentIndex);

        } else {
            root.add(this);
        }

        // assign same parent on child structures
        const metadata: Metadata = this.ref.constructor[Symbol.metadata];
        if (metadata) {
            metadata[$refTypeFieldIndexes]?.forEach((index) => {
                const field = metadata[index as any as number];
                const changeTree: ChangeTree = this.ref[field.name]?.[$changes];
                if (changeTree && changeTree.root !== root) {
                    changeTree.setParent(this.ref, root, index);
                }
            });

        } else if (this.ref[$childType] && typeof(this.ref[$childType]) !== "string") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                const changeTree: ChangeTree = value[$changes];
                if (changeTree.root !== root) {
                    changeTree.setParent(this.ref, root, this.indexes[key] ?? key);
                }
            });
        }

    }

    forEachChild(callback: (change: ChangeTree, atIndex: number) => void) {
        //
        // assign same parent on child structures
        //
        const metadata: Metadata = this.ref.constructor[Symbol.metadata];
        if (metadata) {
            metadata[$refTypeFieldIndexes]?.forEach((index) => {
                const field = metadata[index as any as number];
                const value = this.ref[field.name];
                if (value) {
                    callback(value[$changes], index);
                }
            });

        } else if (this.ref[$childType] && typeof(this.ref[$childType]) !== "string") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                callback(value[$changes], this.indexes[key] ?? key);
            });
        }
    }

    operation(op: OPERATION) {
        // operations without index use negative values to represent them
        // this is checked during .encode() time.
        if (this.filteredChanges !== undefined) {
            this.filteredChanges.operations.push(-op);
            enqueueChangeTree(this.root, this, 'filteredChanges');

        } else {
            this.changes.operations.push(-op);
            enqueueChangeTree(this.root, this, 'changes');
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const metadata = this.ref.constructor[Symbol.metadata] as Metadata;

        const isFiltered = this.isFiltered || (metadata?.[index]?.tag !== undefined);
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
                enqueueChangeTree(this.root, this, 'filteredChanges');
                enqueueChangeTree(this.root, this, 'allFilteredChanges');
            }

        } else {
            setOperationAtIndex(this.allChanges, index);
            enqueueChangeTree(this.root, this, 'changes');
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

        const newIndexedOperations = {};
        const newIndexes = {};
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
        const newIndexes = {};
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
            enqueueChangeTree(this.root, this, 'filteredChanges');

        } else {
            setOperationAtIndex(this.allChanges, allChangesIndex);
            setOperationAtIndex(this.changes, index);
            enqueueChangeTree(this.root, this, 'changes');
        }
    }

    getType(index?: number) {
        if (Metadata.isValidInstance(this.ref)) {
            const metadata = this.ref.constructor[Symbol.metadata] as Metadata;
            return metadata[index].type;

        } else {
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            return this.ref[$childType];
        }
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
        return this.ref[$getByIndex](index, isEncodeAll);
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
            enqueueChangeTree(this.root, this, 'filteredChanges');

        } else {
            enqueueChangeTree(this.root, this, 'changes');
        }

        return previousValue;
    }

    endEncode(changeSetName: ChangeSetName) {
        this.indexedOperations = {};

        // clear changeset
        this[changeSetName].indexes = {};
        this[changeSetName].operations.length = 0;
        this[changeSetName].queueRootIndex = undefined;

        // ArraySchema and MapSchema have a custom "encode end" method
        this.ref[$onEncodeEnd]?.();

        // Not a new instance anymore
        this.isNew = false;
    }

    discard(discardAll: boolean = false) {
        //
        // > MapSchema:
        //      Remove cached key to ensure ADD operations is unsed instead of
        //      REPLACE in case same key is used on next patches.
        //
        this.ref[$onEncodeEnd]?.();

        this.indexedOperations = {};

        this.changes.indexes = {};
        this.changes.operations.length = 0;
        this.changes.queueRootIndex = undefined;

        if (this.filteredChanges !== undefined) {
            this.filteredChanges.indexes = {};
            this.filteredChanges.operations.length = 0;
            this.filteredChanges.queueRootIndex = undefined;
        }

        if (discardAll) {
            this.allChanges.indexes = {};
            this.allChanges.operations.length = 0;

            if (this.allFilteredChanges !== undefined) {
                this.allFilteredChanges.indexes = {};
                this.allFilteredChanges.operations.length = 0;
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

    ensureRefId() {
        // skip if refId is already set.
        if (this.refId !== undefined) {
            return;
        }

        this.refId = this.root.getNextUniqueId();
    }

    get changed() {
        return (Object.entries(this.indexedOperations).length > 0);
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number) {
        const isNewChangeTree = this.root.add(this);

        if (this.root.types.hasFilters) {
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this._checkFilteredByParent(parent, parentIndex);

            if (this.filteredChanges !== undefined) {
                enqueueChangeTree(this.root, this, 'filteredChanges');
                if (isNewChangeTree) {
                    this.root.allFilteredChanges.push(this);
                }
            }
        }

        if (!this.isFiltered) {
            enqueueChangeTree(this.root, this, 'changes');
            if (isNewChangeTree) {
                this.root.allChanges.push(this);
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
            :  this.ref[$childType];

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

}
