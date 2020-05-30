import { Ref, Root } from "./Root";

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
// FieldCache is used for @filter()
//
export interface FieldCache {
    beginIndex: number;
    endIndex: number;
}

export class ChangeTree {
    uniqueId: number;

    changes = new Map<FieldKey, ChangeOperation>();
    allChanges = new Set<FieldKey>();

    constructor(
        public ref: Ref,
        public indexes: { [field: string]: number } = {},
        public parent?: ChangeTree,
        protected _root?: Root,
    ) {
        this.root = _root || new Root();
    }

    set root(value: Root) {
        this._root = value;
        this.uniqueId = this._root.nextUniqueId++;
    }
    get root () { return this._root; }

    change(fieldName: FieldKey) {
        const index = this.indexes[fieldName];
        const field = (typeof(index) === "number") ? index : fieldName;

        const op = (this.allChanges.has(fieldName))
            ? Operation.REPLACE
            : Operation.ADD;

        if (!this.changes.has(field)) {
            this.changes.set(field, { op, index })

            //
            // TODO:
            // check for ADD operation during encoding.
            // add ASSIGN operator matching the ChangeTree ID.
            //

            // if (this.parent) {
            //     this.parent.change(this.parentField);
            // }
        }

        this.allChanges.add(field);

        this.root.dirty(this);
    }

    delete(fieldName: FieldKey) {
        const fieldIndex = this.indexes[fieldName];
        const field = (typeof (fieldIndex) === "number") ? fieldIndex : fieldName;

        this.changes.set(field, { op: Operation.DELETE, index: fieldIndex });
        this.allChanges.delete(field);
    }

    discard() {
        this.changes.clear();
    }

    clone() {
        return new ChangeTree(this.ref, this.indexes, this.parent, this.root);
    }

}
