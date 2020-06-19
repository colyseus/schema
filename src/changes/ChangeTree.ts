import { OPERATION } from "../spec";
import { Schema } from "../Schema";
import { PrimitiveType, FilterChildrenCallback, SchemaDefinition } from "../annotations";
import { MapSchema } from "../types/MapSchema";
import { ArraySchema } from "../types/ArraySchema";

// type FieldKey = string | number;

export type Ref = Schema | ArraySchema | MapSchema;

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
    nextUniqueId: number = 0;
    refs = new Map<number, Ref>();

    changes = new Set<ChangeTree>();
    allChanges = new Set<ChangeTree>();

    dirty(change: ChangeTree) {
        this.changes.add(change);
        this.allChanges.add(change);
    }

    discard(change: ChangeTree) {
        this.changes.delete(change);
    }

    delete (change: ChangeTree) {
        this.changes.delete(change);
        this.allChanges.delete(change);
    }
}

export class ChangeTree {
    refId: number;

    indexes: {[index: string]: any};
    parentIndex?: number;

    // TODO: use a single combined reference to all schema field configs here.
    childType: PrimitiveType;
    childrenFilter: FilterChildrenCallback;

    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    // cached indexes for filtering
    caches: {[field: number]: FieldCache} = {};

    constructor(
        public ref: Ref,
        public parent?: Ref,
        protected _root?: Root,
    ) {
        this.setParent(parent, _root);
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

        // avoid setting parent with empty `root`
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

                    value['$changes'].setParent(
                        this.ref,
                        root,
                        parentIndex
                    );

                    // // skip flagging fields for encoding if item is already on root.
                    // if (root.changes.has(value['$changes'])) {
                    //     continue;
                    // }

                }

                // //
                // // flag all not-null fields for encoding.
                // //
                // if (value !== undefined && value !== null) {
                //     this.change(field);
                // }
            }

        } else if (this.ref instanceof MapSchema) {
            this.ref.forEach((value, key) => {
                if (value instanceof Schema) {
                    const changeTreee = value['$changes'];
                    // const parentIndex = definition.indexes[field];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        // parentIndex,
                    );

                    // const parentDefinition = (this.parent as Schema)['_definition'];
                    // changeTreee.childType = parentDefinition.schema[parentDefinition.fieldsByIndex[this.parentIndex]]
                }
                // value.$changes.change(key);
            });

        } else if (this.ref instanceof ArraySchema) {
            this.ref.forEach((value, key) => {
                // console.log("SETTING PARENT BY REF:", { key, value });
                if (value instanceof Schema) {
                    const changeTreee = value['$changes'];
                    // const parentIndex = definition.indexes[field];

                    changeTreee.setParent(
                        this.ref,
                        this.root,
                        // parentIndex,
                    );

                    // const parentDefinition = (this.parent as Schema)['_definition'];
                    // changeTreee.childType = parentDefinition.schema[parentDefinition.fieldsByIndex[this.parentIndex]]
                }
                // value.$changes.change(key);
            });

        }
    }

    set root(value: Root) {
        this._root = value;
        this.refId = this._root.nextUniqueId++;

        if (this.changes.size > 0) {
            this._root?.dirty(this);
        }
    }

    get root () { return this._root; }

    change(fieldName: string | number) {
        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.assertValidIndex(index, fieldName);

        const previousChange = this.changes.get(index);

        if (!previousChange || previousChange.op === OPERATION.DELETE) {
            this.changes.set(index, {
                op: (!previousChange)
                    ? OPERATION.ADD
                    : (previousChange.op === OPERATION.DELETE)
                        ? OPERATION.DELETE_AND_ADD
                        : OPERATION.REPLACE,
                index
            })

            //
            // TODO:
            // for better `applyFilters()`, we may need to `.touch()`
            // parent structures here.
            //

            // if (this.parent) {
            //     this.parent.change(this.parentField);
            // }
        }

        this.allChanges.add(index);

        this._root?.dirty(this);
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
        return (this.parent as Schema)['_childFilters'][this.parentIndex];;
    }

    getParentFilter() {
        const parent = this.parent;

        if (!parent) {
            return;
        }

        if (parent['_definition']) {
            return (parent as Schema)['_filters'][this.parentIndex];

        } else {
            return (parent['$changes'].parent as Schema)['_childFilters'][this.parentIndex];
        }

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

        console.log("$changes.delete =>", { fieldName, index });

        // const previousChange = this.changes.get(index);
        // if (!previousChange || previousChange.op !== OPERATION.ADD) {
        //     this.changes.set(index, { op: OPERATION.DELETE, index });
        // }

        this.changes.set(index, { op: OPERATION.DELETE, index });
        this.allChanges.delete(index);

        // delete cache
        delete this.caches[index];

        //
        // delete child from root changes.
        //
        if (this.ref[fieldName] instanceof Schema) {
            this._root?.delete(this.ref[fieldName].$changes);
        }

        this._root?.dirty(this);
    }

    discard() {
        this.changes.clear();
        this.root.discard(this);
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

    protected assertValidIndex(index: number, fieldName: string | number) {
        if (index === undefined) {
            throw new Error(`ChangeTree: missing index for field "${fieldName}"`);
        }
    }

}
