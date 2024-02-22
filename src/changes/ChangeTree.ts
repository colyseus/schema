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
    // changes = new Set<ChangeTracker>();
    changes: ChangeTracker[] = [];
    currentQueue = new Set<ChangeTracker>();
    protected nextUniqueId: number = 1;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    enqueue(changeTree: ChangeTracker) {
        if (!this.currentQueue.has(changeTree)) {
            this.changes.push(changeTree);
            this.currentQueue.add(changeTree);
        }
    }

    dequeue(changeTree: ChangeTracker) {
        const indexOf = this.changes.indexOf(changeTree);
        if (indexOf !== -1) {
            this.changes.splice(indexOf, 1);
        }
        this.currentQueue.delete(changeTree);
    }

    clear() {
        this.currentQueue.clear();
        this.changes.length = 0;
    }
}

export interface ChangeTracker<T = any> {
    root?: Root;

    ref: T;
    refId: number;

    changed: boolean;
    changes: Map<number, ChangeOperation>;
    allChanges: Set<number>;
    indexes: {[index: string]: any};

    ensureRefId(): void;

    setRoot(root: Root): void;
    setParent(parent: Ref, root?: Root, parentIndex?: number): void;

    change(index: number, operation?: OPERATION, encoder?: EncodeOperation): void;
    touch(fieldName: string | number): void;
    delete(fieldName: string | number): void;
    discard(changed?: boolean, discardAll?: boolean): void;
    discardAll(): void;

    getType(index: number): DefinitionType;
    getValue(index: number): any;

    // getChildrenFilter(): FilterChildrenCallback;
    // ensureRefId(): void;
}

export class ChangeTree<T extends Ref=any> implements ChangeTracker {
    ref: T;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any} = {};

    changed: boolean = false;
    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    operations: ChangeOperation[] = [];
    currentCustomOperation: number = 0;

    constructor(ref: T) {
        this.ref = ref;
    }

    setRoot(root: Root) {
        this.root = root;

        root.enqueue(this);

        this.allChanges.forEach((index) => {
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
        this.root['enqueue'](this);

        this.ensureRefId();

        //
        // assign same parent on child structures
        //
        if (Metadata.isValidInstance(this.ref)) {
            const metadata: Metadata = this.ref['constructor'][Symbol.metadata];

            // FIXME: need to iterate over parent metadata instead.
            for (const field in metadata) {
                const value = this.ref[field];

                if (value && value[$changes]) {
                    const parentIndex = metadata[field].index;

                    value[$changes].setParent(
                        this.ref,
                        root,
                        parentIndex,
                    );
                }
            }

        } else if (typeof (this.ref) === "object") {
            // MapSchema / ArraySchema, etc.
            (this.ref as MapSchema).forEach((value, key) => {
                if (Metadata.isValidInstance(value)) {
                    const changeTreee = value[$changes];
                    const parentIndex = this.ref[$changes].indexes[key];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        parentIndex,
                    );
                }
            });
        }
    }

    operation(op: ChangeOperation) {
        this.changes.set(--this.currentCustomOperation, op);
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        const previousChange = this.changes.get(index);

        if (
            !previousChange ||
            previousChange.op === OPERATION.DELETE ||
            previousChange.op === OPERATION.TOUCH // (mazmorra.io's BattleAction issue)
        ) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : operation,
                        // : OPERATION.REPLACE,
                index,
            });
        }

        this.allChanges.add(index);

        this.changed = true;
        // this.touchParents();

        this.root?.enqueue(this);
    }

    touch(fieldName: string | number) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.assertValidIndex(index, fieldName);

        if (!this.changes.has(index)) {
            this.changes.set(index, { op: OPERATION.TOUCH, index });
        }

        this.allChanges.add(index);

        // ensure touch is placed until the $root is found.
        this.touchParents();
    }

    touchParents() {
        if (this.parent) {
            this.parent[$changes].touch(this.parentIndex);
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

        this.changes.set(index, { op: OPERATION.DELETE, index });

        this.allChanges.delete(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            previousValue[$changes].parent = undefined;
            this.root.dequeue(previousValue[$changes]);
        }

        this.changed = true;
        this.touchParents();
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
            this.changes.forEach((change) => {
                if (change.op === OPERATION.DELETE) {
                    const index = this.ref['getIndex'](change.index)
                    delete this.indexes[index];
                }
            });
        }

        this.changes.clear();
        this.changed = changed;

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
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);

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

}
