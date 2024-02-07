import { OPERATION } from "../spec";
import { Schema } from "../Schema";
import { SchemaDefinition, FilterChildrenCallback, Definition, DefinitionType } from "../annotations";

import { MapSchema } from "../types/MapSchema";
import { ArraySchema } from "../types/ArraySchema";
import { CollectionSchema } from "../types/CollectionSchema";
import { SetSchema } from "../types/SetSchema";
import { getIdentifier } from "../types/typeRegistry";
// import { ReferenceTracker } from "./ReferenceTracker";

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

export class Root {
    protected changes = new Set<ChangeTree>();
    protected nextUniqueId: number = 1;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    enqueue(changeTree: ChangeTree) {
        this.changes.add(changeTree);
    }

    clear() {
        this.changes.clear();
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

    currentCustomOperation: number = 0;

    constructor(ref: Ref) {
    // constructor(ref: Ref, parent?: Ref, root?: ReferenceTracker) {
        this.ref = ref;
        // this.setParent(parent, root);
    }

    get definition() {
        return (
            this.ref.constructor[Symbol.metadata] &&
            this.ref.constructor[Symbol.metadata]['def'] as SchemaDefinition
        );
    }

    setRoot(root: Root) {
        this.root = root;

        root.enqueue(this);

        this.allChanges.forEach((index) => {
            const childRef = (this.ref as Schema)['getByIndex'](index);
            if (childRef && childRef['$changes']) {
                childRef['$changes'].setRoot(root);
            }
        });
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        if (!this.indexes) {
            this.indexes = (this.ref instanceof Schema)
                ? this.definition
                : {};
        }

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
        if (this.ref instanceof Schema) {
            const definition: SchemaDefinition = this.definition;

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

    // change(fieldName: string | number, operation: OPERATION = OPERATION.ADD) {
    //     const index = (typeof (fieldName) === "number")
    //         ? fieldName
    //         : this.indexes[fieldName];
    //     this.assertValidIndex(index, fieldName);

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
                index
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
            (this.parent['$changes'] as ChangeTree).touch(this.parentIndex);
        }
    }

    getType(index?: number) {
        if (this.definition) {
            const definition = (this.ref as Schema)['_definition'];
            return definition.schema[definition.fieldsByIndex[index]];

        } else {
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            return this.ref['childType'];

            // return { [getIdentifier(this.ref['constructor'])]: this.ref['childType'] } as DefinitionType;
        }
    }

    getChildrenFilter(): FilterChildrenCallback {
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

        // remove `root` reference
        if (previousValue && previousValue['$changes']) {
            previousValue['$changes'].parent = undefined;
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
        if (!(this.ref instanceof Schema)) {
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

            if (value && value['$changes']) {
                value['$changes'].discardAll();
            }
        });

        this.discard();
    }

    // clone() {
    //     return new ChangeTree(this.ref, this.parent, this.root);
    // }

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
