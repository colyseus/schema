import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

type FieldKey = string | number;

export enum Operation {
    ADD = 'add',
    REPLACE = 'replace',
    DELETE = 'delete'
}

export interface ChangeOperation {
    op: Operation,
    index: number,
}

//
// Root holds all schema references by unique id
//
export class Root {
    nextUniqueId: number = 0;
    refs = new Map<number, Schema | ArraySchema | MapSchema>();
}

//
// FieldCache is used for @filter()
//
export interface FieldCache {
    beginIndex: number;
    endIndex: number;
}

export class ChangeTree {
    uniqueId: number;
    operations = new Map<FieldKey, ChangeOperation>();

    changed: boolean = false;
    changes = new Set<FieldKey>();
    allChanges = new Set<FieldKey>();

    // cached indexes for filtering
    caches: {[field: number]: FieldCache} = {};

    constructor(
        protected indexes: { [field: string]: number } = {},
        protected parent?: ChangeTree,
        protected _root?: Root,
    ) {
        this.root = _root || new Root();
    }

    set root(value: Root) {
        this._root = value;
        this.uniqueId = this._root.nextUniqueId++;
    }

    change(fieldName: FieldKey) {
        const index = this.indexes[fieldName];
        const field = (typeof(index) === "number") ? index : fieldName;

        const op = (this.allChanges.has(fieldName))
            ? Operation.REPLACE
            : Operation.ADD;

        if (!this.operations.has(fieldName)) {
            this.operations.set(fieldName, { op, index })

            //
            // TODO:
            // check for ADD operation during encoding.
            // add ASSIGN operator matching the ChangeTree ID.
            //

            // if (this.parent) {
            //     this.parent.change(this.parentField);
            // }
        }

        this.changed = true;
        this.changes.add(field);

        this.allChanges.add(field);
    }

    delete(fieldName: FieldKey) {
        const fieldIndex = this.indexes[fieldName];
        const field = (typeof (fieldIndex) === "number") ? fieldIndex : fieldName;

        this.operations.set(fieldName, { op: Operation.DELETE, index: fieldIndex });
        this.allChanges.delete(field);
    }

    cache(field: number, beginIndex: number, endIndex: number) {
        this.caches[field] = { beginIndex, endIndex };
    }

    discard() {
        this.changed = false;
        this.changes.clear();
        this.operations.clear();
    }

    clone() {
        return new ChangeTree(this.indexes, this.parent, this.root);
    }

}
