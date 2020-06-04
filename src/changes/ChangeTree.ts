import { Ref, Root } from "./Root";
import { OPERATION } from "../spec";
import { Schema } from "../Schema";

// type FieldKey = string | number;

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

export class ChangeTree {
    refId: number;

    changes = new Map<number, ChangeOperation>();
    allChanges = new Set<number>();

    constructor(
        public ref: Ref,
        public indexes: { [field: string]: number } = {},
        public parent?: ChangeTree,
        protected _root?: Root,
    ) {
        this.setParent(parent, _root || new Root());
    }

    setParent(parent: ChangeTree, root: Root) {
        this.parent = parent;
        this.root = root;

        //
        // assign same parent on child structures
        //
        for (let field in this.indexes) {
            if (this.ref[field] instanceof Schema) {
                this.ref[field].$changes.setParent(parent, root);
            }

            //
            // flag all not-null fields for encoding.
            //
            if (this.ref[field] !== undefined && this.ref[field] !== null) {
                this.change(field);
            }
        }
    }

    set root(value: Root) {
        this._root = value;
        this.refId = this._root.nextUniqueId++;
    }
    get root () { return this._root; }

    change(fieldName: string | number) {
        // const index = this.indexes[fieldName];
        // const field = (typeof(index) === "number") ? index : fieldName;

        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        const op = (this.allChanges.has(index))
            ? OPERATION.REPLACE
            : OPERATION.ADD;

        if (!this.changes.has(index)) {
            this.changes.set(index, { op, index })

            //
            // TODO:
            // check for ADD operation during encoding.
            // add ASSIGN operator matching the ChangeTree ID.
            //

            // if (this.parent) {
            //     this.parent.change(this.parentField);
            // }
        }

        this.allChanges.add(index);

        this.root.dirty(this);
    }

    delete(fieldName: string | number) {
        // const fieldIndex = this.indexes[fieldName];
        // const field = (typeof (fieldIndex) === "number") ? fieldIndex : fieldName;

        const index = (typeof (fieldName) === "number")
            ? fieldName
            : this.indexes[fieldName];

        this.changes.set(index, { op: OPERATION.DELETE, index });
        this.allChanges.delete(index);

        //
        // delete child from root changes.
        //
        if (this.ref[fieldName] instanceof Schema) {
            this.root.delete(this.ref[fieldName].$changes);
        }
    }

    discard() {
        this.changes.clear();
        this.root.delete(this);
    }

    clone() {
        return new ChangeTree(this.ref, this.indexes, this.parent, this.root);
    }

}
