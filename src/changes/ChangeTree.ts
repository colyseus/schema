import { OPERATION } from "../spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $encoder, $getByIndex } from "./consts";
import type { FilterChildrenCallback, DefinitionType } from "../annotations";

import type { MapSchema } from "../types/MapSchema";
import type { ArraySchema } from "../types/ArraySchema";
import type { CollectionSchema } from "../types/CollectionSchema";
import type { SetSchema } from "../types/SetSchema";

import { Metadata } from "../Metadata";
import type { EncodeOperation } from "./EncodeOperation";
import type { DecodeOperation } from "./DecodeOperation";
import type { StateView } from "../filters/StateView";

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

export interface ChangeOperation {
    op: OPERATION,
    index: number,
}

export class Root {
    currentQueue = new Set<ChangeTree>();
    protected nextUniqueId: number = 0;

    allChanges = new Map<ChangeTree, Map<number, OPERATION>>();
    changes = new Map<ChangeTree, Map<number, OPERATION>>();
    filteredChanges = new Map<ChangeTree, Map<number, OPERATION>>();

    views: StateView[] = [];

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    remove(changeTree: ChangeTree) {
        this.allChanges.delete(changeTree);
        this.changes.delete(changeTree);
        this.filteredChanges.delete(changeTree);
    }

    clear() {
        this.currentQueue.clear();
        this.changes.clear();
    }
}

export class ChangeTree<T extends Ref=any> {
    ref: T;
    refId: number;

    root?: Root;

    isFiltered?: boolean;
    isPartiallyFiltered?: boolean;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any} = {};

    allChanges = new Map<number, OPERATION>();
    changes = new Map<number, OPERATION>();
    filteredChanges = new Map<number, OPERATION>();

    operations: ChangeOperation[] = [];
    currentCustomOperation: number = 0;

    constructor(ref: T) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;

        //
        // At Schema initialization, the "root" structure might not be available
        // yet, as it only does once the "Encoder" has been set up.
        //
        // So the "parent" may be already set without a "root".
        //
        if (this.parent) {
            this.checkIsFiltered(this.parent, this.parentIndex);
        }

        // unique refId for the ChangeTree.
        this.ensureRefId();

        if (!this.isFiltered) {
            this.root.changes.set(this, this.changes);
        }
        if (this.isFiltered || this.isPartiallyFiltered) {
            this.root.filteredChanges.set(this, this.filteredChanges);
        }
        this.root.allChanges.set(this, this.allChanges);

        // root.enqueue(this);

        this.allChanges.forEach((_, index) => {
            const childRef = this.ref[$getByIndex](index);
            if (childRef && childRef[$changes]) {
                childRef[$changes].setRoot(root);
            }
        });
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

        this.root = root;
        this.checkIsFiltered(parent, parentIndex);

        // this.root.enqueue(this);
        if (!this.isFiltered) {
            this.root.changes.set(this, this.changes);
        }
        if (this.isFiltered || this.isPartiallyFiltered) {
            this.root.filteredChanges.set(this, this.filteredChanges);
        }
        this.root.allChanges.set(this, this.allChanges);

        this.ensureRefId();

        this.forEachChild((changeTree, atIndex) => {
            changeTree.setParent(this.ref, root, atIndex);
        });
    }

    forEachChild(callback: (change: ChangeTree, atIndex: number) => void) {
        //
        // assign same parent on child structures
        //
        if (Metadata.isValidInstance(this.ref)) {
            const metadata: Metadata = this.ref['constructor'][Symbol.metadata];

            // FIXME: need to iterate over parent metadata instead.
            for (const field in metadata) {
                const value = this.ref[field];

                if (value && value[$changes]) {
                    callback(value[$changes], metadata[field].index);

                }
            }

        } else if (typeof (this.ref) === "object") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                if (Metadata.isValidInstance(value)) {
                    callback(value[$changes], this.ref[$changes].indexes[key]);
                }
            });
        }
    }

    operation(op: ChangeOperation) {
        this.changes.set(--this.currentCustomOperation, op.op);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;

        const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].owned);
        const changeSet = (isFiltered)
            ? this.filteredChanges
            : this.changes;

        const previousChange = changeSet.get(index);

        if (!previousChange || previousChange === OPERATION.DELETE) {
            const op = (!previousChange)
                ? operation
                : (previousChange === OPERATION.DELETE)
                    ? OPERATION.DELETE_AND_ADD
                    : operation
            changeSet.set(index, op);
        }

        //
        // TODO: are DELETE operations being encoded as ADD here ??
        //
        this.allChanges.set(index, OPERATION.ADD);

        // this.allChanges.add(index);

        if (isFiltered) {
            this.root?.filteredChanges.set(this, this.filteredChanges);

        } else {
            this.root?.changes.set(this, this.changes);
        }

        // this.root?.changes.set(this, this.changes);
        // this.root?.enqueue(this);
    }

    getType(index?: number) {
        if (Metadata.isValidInstance(this.ref)) {
            const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;
            return metadata[metadata[index]].type;

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

    getChildrenFilter(): FilterChildrenCallback {
        const childFilters = (this.parent as Schema)['metadata'].childFilters;
        return childFilters && childFilters[this.parentIndex];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number) {
        return this.ref[$getByIndex](index);
    }

    delete(fieldName: string | number) {
        const index = this.indexes[fieldName];

        if (index === undefined) {
            console.warn(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index: ${fieldName} (${index})`);
            return;
        }

        const previousValue = this.getValue(index);

        this.changes.set(index, OPERATION.DELETE);

        this.allChanges.delete(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].parent = undefined;
            this.root.remove(previousValue[$changes]);
        }
    }

    discard(changed: boolean = false, discardAll: boolean = false) {
        //
        // Map, Array, etc:
        // Remove cached key to ensure ADD operations is unsed instead of
        // REPLACE in case same key is used on next patches.
        //
        // TODO: refactor this. this is not relevant for Collection and Set.
        //
        if (!(Metadata.isValidInstance(this.ref))) {
            this.changes.forEach((op, fieldIndex) => {
                if (op === OPERATION.DELETE) {
                    const index = this.ref['getIndex'](fieldIndex)
                    delete this.indexes[index];
                }
            });
        }

        this.changes.clear();
        this.filteredChanges.clear();

        if (discardAll) {
            this.allChanges.clear();
        }

        // re-set `currentCustomOperation`
        this.currentCustomOperation = 0;
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

    protected assertValidIndex(index: number, fieldName: string | number) {
        if (index === undefined) {
            throw new Error(`ChangeTree: missing index for field "${fieldName}"`);
        }
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number) {
        // Detect if current structure has "filters" declared
        this.isPartiallyFiltered = this.ref['constructor']?.[Symbol.metadata]?.[-2];

        // TODO: support "partially filtered", where the instance is visible, but only a field is not.

        // Detect if parent has "filters" declared
        while (!this.isFiltered && parent) {
            const metadata = parent['constructor'][Symbol.metadata];

            const fieldName = metadata?.[parentIndex];
            const isParentOwned = metadata?.[fieldName]?.owned;

            this.isFiltered = isParentOwned || parent[$changes].isFiltered; // metadata?.[-2]

            parent = parent[$changes].parent;
        };

        // console.log("< ", this.ref.constructor.name, "isFiltered??", this.isFiltered, "\n");

    }

}
