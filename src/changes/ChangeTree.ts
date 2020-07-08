import { OPERATION } from "../spec";
import { Schema } from "../Schema";
import { SchemaDefinition } from "../annotations";

import { MapSchema } from "../types/MapSchema";
import { ArraySchema } from "../types/ArraySchema";
import { CollectionSchema } from "../types/CollectionSchema";
import { SetSchema } from "../types/SetSchema";

// type FieldKey = string | number;

export type Ref = Schema
    | ArraySchema
    | MapSchema
    | CollectionSchema
    | SetSchema;

export interface ChangeOperation {
    op: OPERATION,
    index: number,
}

//
// FieldCache is used for @filter()
//
export interface FieldCache {
    beginIndex: number;
    endIndex: number;
}


//
// Root holds all schema references by unique id
//
export class Root {
    public refs = new Map<number, Ref>();
    protected nextUniqueId: number = 0;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    // changes = new Set<ChangeTree>();
    // allChanges = new Set<ChangeTree>();

    // dirty(change: ChangeTree) {
    //     this.changes.add(change);
    //     this.allChanges.add(change);
    // }

    // discard(change: ChangeTree) {
    //     this.changes.delete(change);
    // }

    // delete (change: ChangeTree) {
    //     this.changes.delete(change);
    //     this.allChanges.delete(change);
    // }
}

export class ChangeTree {
    ref: Ref;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any};

    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    // cached indexes for filtering
    caches: {[field: number]: FieldCache} = {};

    currentCustomOperation: number = 0;

    constructor(ref: Ref, parent?: Ref, root?: Root) {
        this.ref = ref;
        this.setParent(parent, root);
    }

    get changed () {
        return this.changes.size > 0;
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        if (!this.indexes) {
            this.indexes = (this.ref instanceof Schema)
                ? this.ref['_definition'].indexes
                : {};
        }

        this.parent = parent;
        this.parentIndex = parentIndex;

        // avoid setting parents with empty `root`
        if (!root) { return; }
        this.root = root;

        //
        // assign same parent on child structures
        //
        if (this.ref instanceof Schema) {
            const definition: SchemaDefinition = this.ref['_definition'];

            for (let field in definition.schema) {
                const value = this.ref[field];

                if (value && value['$changes']) {
                    const parentIndex = definition.indexes[field];

                    (value['$changes'] as ChangeTree).setParent(
                        this.ref,
                        root,
                        parentIndex,
                    );
                }
            }

        } else if (
            this.ref instanceof MapSchema ||
            this.ref instanceof ArraySchema ||
            this.ref instanceof CollectionSchema ||
            this.ref instanceof SetSchema
        ) {
            this.ref.forEach((value, key) => {
                if (value instanceof Schema) {
                    const changeTreee = value['$changes'];
                    const parentIndex = this.ref['$changes'].indexes[key];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        parentIndex,
                    );
                }
            });

        // } else if (this.ref instanceof ArraySchema) {
        //     this.ref.forEach((value, key) => {
        //         // console.log("SETTING PARENT BY REF:", { key, value });
        //         if (value instanceof Schema) {
        //             const changeTreee = value['$changes'];
        //             const parentIndex = this.ref['$changes'].indexes[key];

        //             changeTreee.setParent(
        //                 this.ref,
        //                 this.root,
        //                 parentIndex,
        //             );

        //             // const parentDefinition = (this.parent as Schema)['_definition'];
        //             // changeTreee.childType = parentDefinition.schema[parentDefinition.fieldsByIndex[this.parentIndex]]
        //         }
        //         // value.$changes.change(key);
        //     });

        }
    }

    operation(op: ChangeOperation) {
        this.changes.set(--this.currentCustomOperation, op);
    }

    change(fieldName: string | number, operation: OPERATION = OPERATION.ADD) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.assertValidIndex(index, fieldName);

        const previousChange = this.changes.get(index);

        if (!previousChange || previousChange.op === OPERATION.DELETE) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? operation
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : OPERATION.REPLACE,
                index
            });
        }

        this.allChanges.add(index);

        this.touchParents();
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
            (this.parent['$changes'] as ChangeTree).touch(this.parentIndex);
        }
    }

    getType(index: number) {
        if (this.ref['_definition']) {
            const definition = (this.ref as Schema)['_definition'];
            return definition.schema[ definition.fieldsByIndex[index] ];

        } else {
            const definition = (this.parent as Schema)['_definition'];
            const parentType = definition.schema[ definition.fieldsByIndex[this.parentIndex] ];

            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            return Object.values(parentType)[0];
        }
    }

    getChildrenFilter() {
        const _childFilters = (this.parent as Schema)['_childFilters'];
        return _childFilters && _childFilters[this.parentIndex];
    }

    //
    // used during `.encode()`
    //
    getValue(index: number) {
        return this.ref['getByIndex'](index);
    }

    delete(fieldName: string | number) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        if (index === undefined) {
            console.warn("MapSchema: trying to delete non-existing value. ")
            return;
        }

        const previousValue = this.getValue(index);
        // console.log("$changes.delete =>", { fieldName, index, previousValue });

        this.changes.set(index, { op: OPERATION.DELETE, index });

        this.allChanges.delete(index);

        // delete cache
        delete this.caches[index];

        // remove `root` reference
        if (previousValue && previousValue['$changes']) {
            previousValue['$changes'].parent = undefined;
        }

        this.touchParents();

        // this.root?.dirty(this);
    }

    discard() {
        this.changes.clear();

        // re-set `currentCustomOperation`
        this.currentCustomOperation = 0;

        // this.root?.discard(this);
    }

    /**
     * Recursively discard all changes from this, and child structures.
     */
    discardAll() {
        this.changes.forEach((change) => {
            const value = this.getValue(change.index);

            if (value['$changes']) {
                value['$changes'].discardAll();
            }
        });

        this.discard();
    }

    cache(field: number, beginIndex: number, endIndex: number) {
        this.caches[field] = { beginIndex, endIndex };
    }

    clone() {
        return new ChangeTree(this.ref, this.parent, this.root);
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
