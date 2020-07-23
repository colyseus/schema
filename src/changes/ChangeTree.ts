import { OPERATION } from "../spec";
import { Schema } from "../Schema";
import { SchemaDefinition } from "../annotations";

import { MapSchema } from "../types/MapSchema";
import { ArraySchema } from "../types/ArraySchema";
import { CollectionSchema } from "../types/CollectionSchema";
import { SetSchema } from "../types/SetSchema";

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
    //
    // Relation of refId => Schema structure
    // For direct access of structures during decoding time.
    //
    public refs = new Map<number, Ref>();
    public refCounts: {[refId: number]: number} = {};
    public deletedRefs = new Set<number>();

    protected nextUniqueId: number = 0;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    // for decoding
    addRef(refId: number, ref: Ref) {
        this.refs.set(refId, ref);
        this.refCounts[refId] = (this.refCounts[refId] || 0) + 1;
        // console.log("addRef:", { refId });
    }

    // for decoding
    removeRef(refId) {
        this.refCounts[refId] = this.refCounts[refId] - 1;
        this.deletedRefs.add(refId);
        // console.log("removeRef:", { refId });
    }

    // for decoding
    garbageCollectDeletedRefs() {
        this.deletedRefs.forEach((refId) => {
            if (this.refCounts[refId] <= 0) {
                const ref = this.refs.get(refId);

                if (ref instanceof Schema) {
                    for (const fieldName in ref['_definition'].schema) {
                        if (
                            typeof (ref['_definition'].schema[fieldName]) !== "string" &&
                            ref[fieldName] &&
                            ref[fieldName]['$changes']
                        ) {
                            this.removeRef(ref[fieldName]['$changes'].refId);
                        }
                    }
                }

                this.refs.delete(refId);
            }
        });

        // clear deleted refs.
        this.deletedRefs.clear();
    }
}

export class ChangeTree {
    ref: Ref;
    refId: number;

    root?: Root;

    parent?: Ref;
    parentIndex?: number;

    indexes: {[index: string]: any};

    changed: boolean = false;
    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    // cached indexes for filtering
    caches: {[field: number]: number[]} = {};

    currentCustomOperation: number = 0;

    constructor(ref: Ref, parent?: Ref, root?: Root) {
        this.ref = ref;
        this.setParent(parent, root);
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

        } else if (typeof (this.ref) === "object") {
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
                        : operation,
                        // : OPERATION.REPLACE,
                index
            });
        }

        this.allChanges.add(index);

        this.changed = true;
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

    getType(index?: number) {
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
        const childFilters = (this.parent as Schema)['_definition'].childFilters;
        return childFilters && childFilters[this.parentIndex];
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
            console.warn(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index: ${fieldName} (${index})`);
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

        this.changed = true;
        this.touchParents();

        // this.root?.dirty(this);
    }

    discard(changed: boolean = false) {
        this.changes.clear();
        this.changed = changed;

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

            if (value && value['$changes']) {
                value['$changes'].discardAll();
            }
        });

        this.discard();
    }

    // cache(field: number, beginIndex: number, endIndex: number) {
    cache(field: number, cachedBytes: number[]) {
        this.caches[field] = cachedBytes;
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
