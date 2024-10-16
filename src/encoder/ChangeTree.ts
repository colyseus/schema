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

export interface ChangeSet {
    [index: number]: OPERATION;
};

export type Ref = Schema
    | ArraySchema
    | MapSchema
    | CollectionSchema
    | SetSchema;

export class ChangeTree<T extends Ref=any> {
    ref: T;
    refId: number;

    root?: Root;
    parent?: Ref;
    parentIndex?: number;

    isFiltered: boolean = false;
    isPartiallyFiltered: boolean = false;

    currentOperationIndex: number = 0;

    changes: ChangeSet = {};
    allChanges: ChangeSet = {};

    allFilteredChanges: ChangeSet;
    filteredChanges: ChangeSet;

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
        if (ref.constructor[Symbol.metadata]?.["-2"]) {
            this.allFilteredChanges = {};
            this.filteredChanges = {};
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
            metadata["-4"]?.forEach((index) => {
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
            metadata["-4"]?.forEach((index) => {
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
            metadata["-4"]?.forEach((index) => {
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
        this.changes[--this.currentOperationIndex] = op;

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

        const previousOperation = changeSet[index];
        if (!previousOperation || previousOperation === OPERATION.DELETE) {
            const op = (!previousOperation)
                ? operation
                : (previousOperation === OPERATION.DELETE)
                    ? OPERATION.DELETE_AND_ADD
                    : operation
            //
            // TODO: are DELETE operations being encoded as ADD here ??
            //
            changeSet[index] = op;
        }

        if (isFiltered) {
            this.allFilteredChanges[index] = OPERATION.ADD;

            if (this.root) {
                if (this.root.filteredChanges.indexOf(this) === -1) {
                    this.root.filteredChanges.push(this);
                }
                if (this.root.allFilteredChanges.indexOf(this) === -1) {
                    this.root.allFilteredChanges.push(this);
                }
            }

        } else {
            this.allChanges[index] = OPERATION.ADD;
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

        const changeSetEntries = Object.entries(changeSet);

        // Clear the object
        for (const key in changeSet) {
            delete changeSet[key];
        }

        // Re-insert each entry with the shifted index
        for (const [index, op] of changeSetEntries) {
            changeSet[Number(index) + shiftIndex] = op;
        }
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

    private _shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0, allChangeSet: ChangeSet) {
        Object.entries(allChangeSet).forEach(([key, op]) => {
            const index = Number(key);
            if (index >= startIndex) {
                delete allChangeSet[key];
                allChangeSet[index + shiftIndex] = op;
            }
        });
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex = index) {
        // console.log("INDEXED OPERATION! => filteredChanges", this.filteredChanges);

        if (this.filteredChanges) {
            this.allFilteredChanges[allChangesIndex] = OPERATION.ADD;
            this.filteredChanges[index] = operation;
            if (this.root?.filteredChanges.indexOf(this) === -1) {
                this.root.filteredChanges.push(this);
            }

        } else {
            this.allChanges[allChangesIndex] = OPERATION.ADD;
            this.changes[index] = operation;
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
        // TODO: optimize this. avoid checking against multiple instances
        return this.changes[index] ?? this.filteredChanges?.[index];
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

        const previousValue = this.getValue(index);

        changeSet[index] = operation ?? OPERATION.DELETE;

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
            delete this.allFilteredChanges[allChangesIndex];
            if (this.root?.filteredChanges.indexOf(this) === -1) {
                this.root.filteredChanges.push(this);
            }


        } else {
            delete this.allChanges[allChangesIndex];
            if (this.root?.changes.indexOf(this) === -1) {
                this.root.changes.push(this);
            }
        }
    }

    endEncode() {
        // this.changes.clear();
        // for (const index in this.changes) { delete this.changes[index]; }
        this.changes = {};

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

        this.changes = {};

        if (this.filteredChanges !== undefined) {
            this.filteredChanges = {};
        }

        // reset operation index
        this.currentOperationIndex = 0;

        if (discardAll) {
            this.allChanges = {};
            this.allFilteredChanges = {};

            // remove children references
            this.forEachChild((changeTree, _) =>
                this.root?.remove(changeTree));
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        const keys = Object.keys(this.changes);
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
        return (Object.entries(this.changes).length > 0);
    }

    protected checkIsFiltered(metadata: Metadata, parent: Ref, parentIndex: number) {
        // Detect if current structure has "filters" declared
        this.isPartiallyFiltered = metadata?.["-2"] !== undefined;

        if (this.isPartiallyFiltered) {
            this.filteredChanges = this.filteredChanges || {};
            this.allFilteredChanges = this.allFilteredChanges || {};
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
        this.isFiltered = parentMetadata?.["-2"]?.includes(parentIndex);

        //
        // TODO: refactor this!
        //
        //      swapping `changes` and `filteredChanges` is required here
        //      because "isFiltered" may not be imedialely available on `change()`
        //
        if (this.isFiltered) {
            this.filteredChanges = {};
            this.allFilteredChanges = {};

            if (Object.keys(this.changes).length > 0) {
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
