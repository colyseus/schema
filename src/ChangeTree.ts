import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

type FieldKey = string | number;

export class ChangeTree {
    fieldIndexes: {[field: string]: number};

    changed: boolean = false;
    changes = new Set<FieldKey>();
    allChanges = new Set<FieldKey>();

    /**
     * `MapSchema` / `ArraySchema`
     */
    indexMap: Map<any, FieldKey>;
    indexChange: Map<any, FieldKey>;
    deletedKeys: any = {};

    /**
     * parent link & field name
     */
    parent: ChangeTree;
    parentField: FieldKey;

    constructor(
        indexes: { [field: string]: number } = {},
        parentField: FieldKey = null,
        parent?: ChangeTree
    ) {
        this.fieldIndexes = indexes;

        this.parent = parent;
        this.parentField = parentField;
    }

    change(fieldName: FieldKey, isDelete: boolean = false) {
        const fieldIndex = this.fieldIndexes[fieldName];
        const field = (typeof(fieldIndex) === "number") ? fieldIndex : fieldName;

        if (!isDelete) {
            this.changed = true;
            this.changes.add(field);

            this.allChanges.add(field);

        } else if (isDelete) {
            // if (this.changes.has(field))  {
            //     /**
            //      * un-flag a change if item has been added AND removed in the same patch.
            //      * (https://github.com/colyseus/colyseus-unity3d/issues/103)
            //      */
            //     this.changes.delete(field);

            // } else {
                this.changed = true;
                this.changes.add(field);
            // }

            // discard all-changes for removed items.
            this.allChanges.delete(field);
        }

        if (this.parent) {
            this.parent.change(this.parentField);
        }
    }

    mapIndex(instance: any, key: FieldKey) {
        if (typeof instance === "object") {
            if (!this.indexMap) {
                this.indexMap = new Map<any, FieldKey>();
                this.indexChange = new Map<any, FieldKey>();
            }

            this.indexMap.set(instance, key);
        }
    }

    getIndex (instance: any) {
        return this.indexMap && this.indexMap.get(instance);
    }

    deleteIndex(instance: any) {
        if (typeof instance === "object") {
            this.deletedKeys[this.indexMap.get(instance)] = true;
            this.indexMap.delete(instance);
        }
    }

    isDeleted(key: any) {
        return this.deletedKeys[key] !== undefined;
    }

    mapIndexChange(instance: any, previousKey: FieldKey) {
        if (typeof instance === "object" && !this.indexChange.has(instance)) {
            this.indexChange.set(instance, previousKey);
        }
    }

    getIndexChange (instance: any) {
        return this.indexChange && this.indexChange.get(instance);
    }

    deleteIndexChange(instance: any) {
        if (typeof instance === "object") {
            this.indexChange.delete(instance);
        }
    }

    changeAll(obj: Schema | ArraySchema | MapSchema) {
        if (obj instanceof Schema) {
            const schema = obj._schema;
            for (const field in schema) {

                // ensure ArraySchema and MapSchema already initialized
                // on its structure have a valid parent.
                if (
                    (
                        obj[field] instanceof Schema ||
                        obj[field] instanceof ArraySchema ||
                        obj[field] instanceof MapSchema
                    ) &&
                    !obj[field].$changes.parent.parent
                ) {
                    obj[field].$changes.parent = this;
                }

                if (obj[field] !== undefined) {
                    this.change(field);
                }
            }

        } else {
            const keys = Object.keys(obj);
            for (const key of keys) {
                if (obj[key] !== undefined) {
                    this.change(key);
                }
            }
        }
    }

    discard() {
        this.changed = false;
        this.changes.clear();
        this.deletedKeys = {};

        if (this.indexChange) {
            this.indexChange.clear();
        }
    }

/*
    markAsUnchanged() {
        const schema = this._schema;
        const changes = this.$changes;

        for (const field in changes) {
            const type = schema[field];
            const value = changes[field];

            // skip unchagned fields
            if (value === undefined) { continue; }

            if ((type as any)._schema) {
                (value as Schema).markAsUnchanged();

            } else if (Array.isArray(type)) {
                // encode Array of type
                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (typeof(type[0]) !== "string") { // is array of Schema
                        (item as Schema).markAsUnchanged();
                    }
                }

            } else if ((type as any).map) {
                const keys = value;
                const mapKeys = Object.keys(this[`_${field}`]);

                for (let i = 0; i < keys.length; i++) {
                    const key = mapKeys[keys[i]] || keys[i];
                    const item = this[`_${field}`][key];

                    if (item instanceof Schema) {
                        item.markAsUnchanged();
                    }
                }
            }
        }

        this.changed = false;
        this.$changes = {};
    }
*/

}
