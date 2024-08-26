import { OPERATION } from "../encoding/spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $isNew } from "../types/symbols";

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

export class ChangeTree<T extends Ref=any> {
    ref: T;
    refId: number;

    root?: Root;
    parent?: Ref;
    parentIndex?: number;

    isFiltered: boolean = false;
    isPartiallyFiltered: boolean = false;

    currentOperationIndex: number = 0;

    changes = new Map<number, OPERATION>();
    allChanges = new Map<number, OPERATION>();

    allFilteredChanges: Map<number, OPERATION>;
    filteredChanges: Map<number, OPERATION>;

    indexes: {[index: string]: any}; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)

    [$isNew] = true;

    constructor(ref: T) {
        this.ref = ref;

        //
        // Does this structure have "filters" declared?
        //
        if (ref.constructor[Symbol.metadata]?.[-2]) {
            this.allFilteredChanges = new Map<number, OPERATION>();
            this.filteredChanges = new Map<number, OPERATION>();
        }
    }

    setRoot(root: Root) {
        this.root = root;
        this.root.add(this);

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
                this.root.allFilteredChanges.set(this, this.allFilteredChanges);
                this.root.filteredChanges.set(this, this.filteredChanges);
            }
        }

        if (!this.isFiltered) {
            this.root.changes.set(this, this.changes);
            this.root.allChanges.set(this, this.allChanges);
        }

        this.ensureRefId();

        if (metadata) {
            metadata[-4]?.forEach((index) => {
                const field = metadata[index as any as number];
                const value = this.ref[field.name];
                if (value) {
                    value[$changes].setRoot(root);
                }
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

        root.add(this);

        const metadata: Metadata = this.ref.constructor[Symbol.metadata];

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;

            if (root.types.hasFilters) {
                this.checkIsFiltered(metadata, parent, parentIndex);

                if (this.isFiltered || this.isPartiallyFiltered) {
                    this.root.filteredChanges.set(this, this.filteredChanges);
                    this.root.allFilteredChanges.set(this, this.filteredChanges);
                }
            }

            if (!this.isFiltered) {
                this.root.changes.set(this, this.changes);
                this.root.allChanges.set(this, this.allChanges);
            }

            this.ensureRefId();
        }

        // assign same parent on child structures
        if (metadata) {
            metadata[-4]?.forEach((index) => {
                const field = metadata[index as any as number];
                const value = this.ref[field.name];
                value?.[$changes].setParent(this.ref, root, index);

                // console.log(this.ref.constructor.name, field.name, value);

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
            metadata[-4]?.forEach((index) => {
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
        this.changes.set(--this.currentOperationIndex, op);
        this.root?.changes.set(this, this.changes);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const metadata = this.ref.constructor[Symbol.metadata] as Metadata;

        const isFiltered = this.isFiltered || (metadata?.[index]?.tag !== undefined);
        const changeSet = (isFiltered)
            ? this.filteredChanges
            : this.changes;

        const previousOperation = changeSet.get(index);
        if (!previousOperation || previousOperation === OPERATION.DELETE) {
            const op = (!previousOperation)
                ? operation
                : (previousOperation === OPERATION.DELETE)
                    ? OPERATION.DELETE_AND_ADD
                    : operation
            //
            // TODO: are DELETE operations being encoded as ADD here ??
            //
            changeSet.set(index, op);
        }

        if (isFiltered) {
            this.allFilteredChanges.set(index, OPERATION.ADD);
            this.root?.filteredChanges.set(this, this.filteredChanges);
            this.root?.allFilteredChanges.set(this, this.allFilteredChanges);

        } else {
            this.allChanges.set(index, OPERATION.ADD);
            this.root?.changes.set(this, this.changes);
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

        const changeSetEntries = Array.from(changeSet.entries());
        changeSet.clear();

        // Re-insert each entry with the shifted index
        for (const [index, op] of changeSetEntries) {
            changeSet.set(index + shiftIndex, op);
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

    private _shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0, allChangeSet: Map<number, OPERATION>) {
        Array.from(allChangeSet.entries()).forEach(([index, op]) => {
            if (index >= startIndex) {
                allChangeSet.delete(index);
                allChangeSet.set(index + shiftIndex, op);
            }
        });
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex = index) {
        if (this.filteredChanges !== undefined) {
            this.allFilteredChanges.set(allChangesIndex, OPERATION.ADD);
            this.filteredChanges.set(index, operation);
            this.root?.filteredChanges.set(this, this.filteredChanges);

        } else {
            this.allChanges.set(allChangesIndex, OPERATION.ADD);
            this.changes.set(index, operation);
            this.root?.changes.set(this, this.changes);
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
        return this.changes.get(index) ?? this.filteredChanges?.get(index);
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

        changeSet.set(index, operation ?? OPERATION.DELETE);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].root = undefined;

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
        // FIXME: this is looking a bit ugly (and repeated from `.change()`)
        //
        if (this.filteredChanges) {
            this.root?.filteredChanges.set(this, this.filteredChanges);
            this.allFilteredChanges.delete(allChangesIndex);

        } else {
            this.root?.changes.set(this, this.changes);
            this.allChanges.delete(allChangesIndex);
        }
    }

    endEncode() {
        this.changes.clear();

        // ArraySchema and MapSchema have a custom "encode end" method
        this.ref[$onEncodeEnd]?.();

        // Not a new instance anymore
        delete this[$isNew];
    }

    discard(discardAll: boolean = false) {
        //
        // > MapSchema:
        //      Remove cached key to ensure ADD operations is unsed instead of
        //      REPLACE in case same key is used on next patches.
        //
        this.ref[$onEncodeEnd]?.();

        this.changes.clear();
        this.filteredChanges?.clear();

        // reset operation index
        this.currentOperationIndex = 0;

        if (discardAll) {
            this.allChanges.clear();
            this.allFilteredChanges?.clear();

            // remove children references
            this.forEachChild((changeTree, _) =>
                this.root?.remove(changeTree));
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((_, fieldIndex) => {
            const value = this.getValue(fieldIndex);

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });

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
        return this.changes.size > 0;
    }

    protected checkIsFiltered(metadata: Metadata, parent: Ref, parentIndex: number) {
        // Detect if current structure has "filters" declared
        this.isPartiallyFiltered = metadata?.[-2] !== undefined;

        if (this.isPartiallyFiltered) {
            this.filteredChanges = this.filteredChanges || new Map<number, OPERATION>();
            this.allFilteredChanges = this.allFilteredChanges || new Map<number, OPERATION>();
        }

        if (parent) {
            if (!Metadata.isValidInstance(parent)) {
                const parentChangeTree = parent[$changes];
                parent = parentChangeTree.parent;
                parentIndex = parentChangeTree.parentIndex;
            }

            const parentMetadata = parent?.constructor?.[Symbol.metadata];
            this.isFiltered = (parent && parentMetadata?.[-2]?.includes(parentIndex));

            //
            // TODO: refactor this!
            //
            //      swapping `changes` and `filteredChanges` is required here
            //      because "isFiltered" may not be imedialely available on `change()`
            //
            if (this.isFiltered) {
                this.filteredChanges = new Map<number, OPERATION>();
                this.allFilteredChanges = new Map<number, OPERATION>();

                if (this.changes.size > 0) {
                    // swap changes reference
                    const changes = this.changes;
                    this.changes = this.filteredChanges;
                    this.filteredChanges = changes;

                    // swap "all changes" reference
                    const allFilteredChanges = this.allFilteredChanges;
                    this.allFilteredChanges = this.allChanges;
                    this.allChanges = allFilteredChanges;
                }
            }
        }
    }

}
