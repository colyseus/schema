import { OPERATION } from "../encoding/spec";
import { Schema } from "../Schema";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $isNew } from "../types/symbols";

import type { MapSchema } from "../types/custom/MapSchema";
import type { ArraySchema } from "../types/custom/ArraySchema";
import type { CollectionSchema } from "../types/custom/CollectionSchema";
import type { SetSchema } from "../types/custom/SetSchema";

import { Metadata } from "../Metadata";
import type { EncodeOperation } from "./EncodeOperation";
import type { DecodeOperation } from "../decoder/DecodeOperation";
import type { StateView } from "./StateView";

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

export class Root {
    protected nextUniqueId: number = 0;
    refCount = new WeakMap<ChangeTree, number>();

    // all changes
    allChanges = new Map<ChangeTree, Map<number, OPERATION>>();
    allFilteredChanges = new Map<ChangeTree, Map<number, OPERATION>>();

    // pending changes to be encoded
    changes = new Map<ChangeTree, Map<number, OPERATION>>();
    filteredChanges = new Map<ChangeTree, Map<number, OPERATION>>();

    views: StateView[] = [];

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    add (changeTree: ChangeTree) {
        const refCount = this.refCount.get(changeTree) || 0;
        this.refCount.set(changeTree, refCount + 1);
    }

    remove(changeTree: ChangeTree) {
        const refCount = this.refCount.get(changeTree);
        if (refCount <= 1) {
            this.allChanges.delete(changeTree);
            this.changes.delete(changeTree);

            if (changeTree.isFiltered || changeTree.isPartiallyFiltered) {
                this.allFilteredChanges.delete(changeTree);
                this.filteredChanges.delete(changeTree);
            }

            this.refCount.delete(changeTree);

        } else {
            this.refCount.set(changeTree, refCount - 1);
        }

        changeTree.forEachChild((child, _) =>
            this.remove(child));
    }

    clear() {
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

    indexes: {[index: string]: any} = {}; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)
    currentOperationIndex: number = 0;

    allChanges = new Map<number, OPERATION>();
    allFilteredChanges = new Map<number, OPERATION>();;

    changes = new Map<number, OPERATION>();
    filteredChanges = new Map<number, OPERATION>();;

    [$isNew] = true;

    constructor(ref: T) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;
        this.root.add(this);

        //
        // At Schema initialization, the "root" structure might not be available
        // yet, as it only does once the "Encoder" has been set up.
        //
        // So the "parent" may be already set without a "root".
        //
        this.checkIsFiltered(this.parent, this.parentIndex);

        // unique refId for the ChangeTree.
        this.ensureRefId();

        if (!this.isFiltered) {
            this.root.changes.set(this, this.changes);
        }

        if (this.isFiltered || this.isPartiallyFiltered) {
            this.root.allFilteredChanges.set(this, this.filteredChanges);
            this.root.filteredChanges.set(this, this.filteredChanges);

        } else {
            this.root.allChanges.set(this, this.allChanges);
        }

        // this.root.allChanges.set(this, this.allChanges);

        this.forEachChild((changeTree, _) => {
            changeTree.setRoot(root);
        });

        // this.allChanges.forEach((_, index) => {
        //     const childRef = this.ref[$getByIndex](index);
        //     if (childRef && childRef[$changes]) {
        //         childRef[$changes].setRoot(root);
        //     }
        // });
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

        // skip if parent is already set
        if (root === this.root) {
            this.forEachChild((changeTree, atIndex) => {
                changeTree.setParent(this.ref, root, atIndex);
            });
            return;
        }

        this.root = root;
        this.checkIsFiltered(parent, parentIndex);

        if (!this.isFiltered) {
            this.root.changes.set(this, this.changes);
        }

        if (this.isFiltered || this.isPartiallyFiltered) {
            this.root.filteredChanges.set(this, this.filteredChanges);
            this.root.allFilteredChanges.set(this, this.filteredChanges);
        } else {
            this.root.allChanges.set(this, this.allChanges);
        }

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

    operation(op: OPERATION) {
        this.changes.set(--this.currentOperationIndex, op);
        this.root?.changes.set(this, this.changes);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;

        const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);
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
            changeSet.set(index, op);
        }

        //
        // TODO: are DELETE operations being encoded as ADD here ??
        //

        if (isFiltered) {
            this.allFilteredChanges.set(index, OPERATION.ADD);
            this.root?.filteredChanges.set(this, this.filteredChanges);

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
        const allChangeSet = (this.isFiltered || this.isPartiallyFiltered)
            ? this.allFilteredChanges
            : this.allChanges;

        //
        // Used only during:
        //
        // - ArraySchema#splice()
        //
        Array.from(allChangeSet.entries()).forEach(([index, op]) => {
            // console.log('shiftAllChangeIndexes', index >= startIndex, { index, op, shiftIndex, startIndex })
            if (index >= startIndex) {
                allChangeSet.delete(index);
                allChangeSet.set(index + shiftIndex, op);
            }
        });
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex = index) {
        const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;

        const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);

        if (isFiltered) {
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

    getChange(index: number) {
        // TODO: optimize this. avoid checking against multiple instances
        return this.changes.get(index) ?? this.filteredChanges.get(index);
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

        const metadata = this.ref['constructor'][Symbol.metadata] as Metadata;
        const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);
        const changeSet = (isFiltered)
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
        if (isFiltered) {
            this.allFilteredChanges.delete(allChangesIndex);
            this.root?.filteredChanges.set(this, this.filteredChanges);

        } else {
            this.allChanges.delete(allChangesIndex);
            this.root?.changes.set(this, this.changes);
        }
    }

    endEncode() {
        this.changes.clear();
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
        this.filteredChanges.clear();

        // reset operation index
        this.currentOperationIndex = 0;

        if (discardAll) {
            this.allChanges.clear();
            this.allFilteredChanges.clear();

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

    protected checkIsFiltered(parent: Ref, parentIndex: number) {
        // Detect if current structure has "filters" declared
        this.isPartiallyFiltered = this.ref['constructor']?.[Symbol.metadata]?.[-2];

        // TODO: support "partially filtered", where the instance is visible, but only a field is not.

        // Detect if parent has "filters" declared
        while (parent && !this.isFiltered) {
            const metadata: Metadata = parent['constructor'][Symbol.metadata];

            const fieldName = metadata?.[parentIndex];
            const isParentOwned = metadata?.[fieldName]?.tag !== undefined;

            this.isFiltered = isParentOwned || parent[$changes].isFiltered; // metadata?.[-2]

            parent = parent[$changes].parent;
        };

        //
        // TODO: refactor this!
        //
        //      swapping `changes` and `filteredChanges` is required here
        //      because "isFiltered" may not be imedialely available on `change()`
        //
        if (this.isFiltered && this.changes.size > 0) {
            // swap changes reference
            const changes = this.changes;
            this.changes = this.filteredChanges;
            this.filteredChanges = changes;

            // this.allFilteredChanges = this.allChanges;
            // this.allChanges.clear();
        }
    }

}
