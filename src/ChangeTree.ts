import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

type FieldKey = string | number | symbol;

export class ChangeTree {
    changed: boolean = false;
    changes: FieldKey[] = [];
    allChanges: FieldKey[] = [];

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

    constructor (parentField: FieldKey = null, parent?: ChangeTree) {
        this.parent = parent;
        this.parentField = parentField;
    }

    change(field: FieldKey, isDelete: boolean = false) {
        this.changed = true;

        if (this.changes.indexOf(field) === -1) {
            this.changes.push(field);
        }

        const allChangesIndex = this.allChanges.indexOf(field);
        if (!isDelete && allChangesIndex === -1) {
            this.allChanges.push(field);

        } else if (isDelete && allChangesIndex >= 0) {
            // discard all-changes for removed items.
            this.allChanges.splice(allChangesIndex, 1);
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
        this.deletedKeys[this.indexMap.get(instance)] = true;
        this.indexMap.delete(instance);
    }

    isDeleted(key: any) {
        return this.deletedKeys[key] !== undefined;
    }

    mapIndexChange(instance: any, key: FieldKey) {
        if (typeof instance === "object") {
            this.indexChange.set(instance, key);
        }
    }

    getIndexChange (instance: any) {
        return this.indexChange && this.indexChange.get(instance);
    }

    deleteIndexChange(instance: any) {
        this.indexChange.delete(instance);
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

                this.change(field);
            }

        } else {
            const keys = Object.keys(obj);
            for (const key of keys) {
                this.change(key);
            }
        }
    }

    discard() {
        this.changed = false;
        this.changes = [];
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