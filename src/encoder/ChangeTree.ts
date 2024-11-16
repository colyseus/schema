import { OPERATION } from "../encoding/spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex } from "../types/symbols";

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
    operations: OPERATION[]
}

export function setOperationAtIndex(changeSet: ChangeSet, index: number) {
    const operationsIndex = changeSet.indexes[index];
    if (operationsIndex === undefined) {
        changeSet.indexes[index] = changeSet.operations.push(index) - 1;
    } else {
        changeSet.operations[operationsIndex] = index;
    }
}

export function deleteOperationAtIndex(changeSet: ChangeSet, index: number) {
    const operationsIndex = changeSet.indexes[index];
    if (operationsIndex !== undefined) {
        changeSet.operations[operationsIndex] = undefined;
    }
    delete changeSet.indexes[index];
}

export class ChangeTree<T extends Ref=any> {
    ref: T;
    refId: number;

    root?: Root;
    parent?: Ref;
    parentIndex?: number;

    isFiltered: boolean = false;
    isPartiallyFiltered: boolean = false;

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
        if (ref.constructor[Symbol.metadata]?.["$_viewFieldIndexes"]) {
            this.allFilteredChanges = { indexes: {}, operations: [] };
            this.filteredChanges = { indexes: {}, operations: [] };
        }
    }

    setRoot(root: Root) {
        this.root = root;
        const isNewChangeTree = this.root.add(this);

        const metadata: Metadata = this.ref.constructor[Symbol.metadata];

        if (this.root.types.hasFilters) {
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this.checkIsFiltered(metadata, this.parent, this.parentIndex);

            if (this.isFiltered || this.isPartiallyFiltered) {
                if (this.root.filteredChanges.indexOf(this) === -1) {
                    this.root.filteredChanges.push(this);
                }
                if (isNewChangeTree) {
                    this.root.allFilteredChanges.push(this);
                }
            }
        }

        if (!this.isFiltered) {
            if (this.root.changes.indexOf(this) === -1) {
                this.root.changes.push(this);
            }
            if (isNewChangeTree) {
                this.root.allChanges.push(this);
            }
        }

        // Recursively set root on child structures
        if (metadata) {
            metadata["$_refTypeFieldIndexes"]?.forEach((index) => {
                const field = metadata[index as any as number];
                const value = this.ref[field.name];
                value?.[$changes].setRoot(root);
            });

        } else if (this.ref[$childType] && typeof(this.ref[$childType]) !== "string") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                value[$changes].setRoot(root);
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

        const metadata: Metadata = this.ref.constructor[Symbol.metadata];

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;
            const isNewChangeTree = root.add(this);

            if (root.types.hasFilters) {
                this.checkIsFiltered(metadata, parent, parentIndex);

                if (this.isFiltered || this.isPartiallyFiltered) {
                    if (this.root.filteredChanges.indexOf(this) === -1) {
                        this.root.filteredChanges.push(this);
                    }
                    if (isNewChangeTree) {
                        this.root.allFilteredChanges.push(this);
                    }
                }
            }

            if (!this.isFiltered) {
                if (this.root.changes.indexOf(this) === -1) {
                    this.root.changes.push(this);
                }
                if (isNewChangeTree) {
                    this.root.allChanges.push(this);
                }
            }

        } else {
            root.add(this);
        }

        // assign same parent on child structures
        if (metadata) {
            metadata["$_refTypeFieldIndexes"]?.forEach((index) => {
                const field = metadata[index as any as number];
                const value = this.ref[field.name];
                value?.[$changes].setParent(this.ref, root, index);

                // try { throw new Error(); } catch (e) {
                //     console.log(e.stack);
                // }

            });

        } else if (this.ref[$childType] && typeof(this.ref[$childType]) !== "string") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                value[$changes].setParent(this.ref, root, this.indexes[key] ?? key);
            });
        }

    }

    forEachChild(callback: (change: ChangeTree, atIndex: number) => void) {
        //
        // assign same parent on child structures
        //
        const metadata: Metadata = this.ref.constructor[Symbol.metadata];
        if (metadata) {
            metadata["$_refTypeFieldIndexes"]?.forEach((index) => {
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
        this.changes.operations.push(-op);

        if (this.root?.changes.indexOf(this) === -1) {
            this.root.changes.push(this);
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
                if (this.root.filteredChanges.indexOf(this) === -1) {
                    this.root.filteredChanges.push(this);
                }
                if (this.root.allFilteredChanges.indexOf(this) === -1) {
                    this.root.allFilteredChanges.push(this);
                }
            }

        } else {
            setOperationAtIndex(this.allChanges, index);

            if (this.root?.changes.indexOf(this) === -1) {
                this.root.changes.push(this);
            }
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
            newIndexes[Number(index) + shiftIndex] = changeSet[index];
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
        if (this.isFiltered || this.isPartiallyFiltered) {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allFilteredChanges);
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);

        } else {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);
        }
    }

    private _shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0, changeSet: ChangeSet) {
        const newIndexes = {};

        for (const key in changeSet.indexes) {
            const index = changeSet.indexes[key];
            if (index > startIndex) {
                newIndexes[Number(key) + shiftIndex] = index;
            } else {
                newIndexes[key] = index;
            }
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

        if (this.filteredChanges) {
            setOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            setOperationAtIndex(this.filteredChanges, index);

            if (this.root?.filteredChanges.indexOf(this) === -1) {
                this.root.filteredChanges.push(this);
            }

        } else {
            setOperationAtIndex(this.allChanges, allChangesIndex);
            setOperationAtIndex(this.changes, index);

            if (this.root?.changes.indexOf(this) === -1) {
                this.root.changes.push(this);
            }
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

        const changeSet = (this.filteredChanges)
            ? this.filteredChanges
            : this.changes;

        this.indexedOperations[index] = operation ?? OPERATION.DELETE;
        setOperationAtIndex(changeSet, index);

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
            // (the property descriptors should NOT be used at decoding time. only at encoding time.)
            //
            this.root?.remove(previousValue[$changes]);
        }

        //
        // FIXME: this is looking a ugly and repeated
        //
        if (this.filteredChanges) {
            deleteOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            if (this.root?.filteredChanges.indexOf(this) === -1) {
                this.root.filteredChanges.push(this);
            }


        } else {
            deleteOperationAtIndex(this.allChanges, allChangesIndex);
            if (this.root?.changes.indexOf(this) === -1) {
                this.root.changes.push(this);
            }
        }
    }

    endEncode() {
        this.indexedOperations = {};

        // // clear changes
        // this.changes.indexes = {};
        // this.changes.operations.length = 0;

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

        if (this.filteredChanges !== undefined) {
            this.filteredChanges.indexes = {};
            this.filteredChanges.operations.length = 0;
        }

        if (discardAll) {
            this.allChanges.indexes = {};
            this.allChanges.operations.length = 0;

            if (this.allFilteredChanges !== undefined) {
                this.allFilteredChanges.indexes = {};
                this.allFilteredChanges.operations.length = 0;
            }

            // remove children references
            this.forEachChild((changeTree, _) =>
                this.root?.remove(changeTree));
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
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

    protected checkIsFiltered(metadata: Metadata, parent: Ref, parentIndex: number) {
        // Detect if current structure has "filters" declared
        this.isPartiallyFiltered = metadata?.["$_viewFieldIndexes"] !== undefined;

        if (this.isPartiallyFiltered) {
            this.filteredChanges = this.filteredChanges || { indexes: {}, operations: [] };
            this.allFilteredChanges = this.allFilteredChanges || { indexes: {}, operations: [] };
        }

        // skip if parent is not set
        if (!parent) {
            return;
        }

        if (!Metadata.isValidInstance(parent)) {
            const parentChangeTree = parent[$changes];
            parent = parentChangeTree.parent;
            parentIndex = parentChangeTree.parentIndex;
        }

        const parentMetadata = parent.constructor?.[Symbol.metadata];
        this.isFiltered = parentMetadata?.["$_viewFieldIndexes"]?.includes(parentIndex);

        //
        // TODO: refactor this!
        //
        //      swapping `changes` and `filteredChanges` is required here
        //      because "isFiltered" may not be imedialely available on `change()`
        //
        if (this.isFiltered) {
            this.filteredChanges = { indexes: {}, operations: [] };
            this.allFilteredChanges = { indexes: {}, operations: [] };

            if (this.changes.operations.length > 0) {
                // swap changes reference
                const changes = this.changes;
                this.changes = this.filteredChanges;
                this.filteredChanges = changes;

                // swap "all changes" reference
                const allFilteredChanges = this.allFilteredChanges;
                this.allFilteredChanges = this.allChanges;
                this.allChanges = allFilteredChanges;

                // console.log("SWAP =>", {
                //     "this.allFilteredChanges": this.allFilteredChanges,
                //     "this.allChanges": this.allChanges
                // })
            }
        }
    }

}
