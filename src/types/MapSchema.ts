import { ChangeTree } from "../changes/ChangeTree";
import { OPERATION } from "../spec";
import { SchemaDecoderCallbacks, Schema } from "../Schema";

export function getMapProxy(value: MapSchema) {
    value['$proxy'] = true;

    value = new Proxy(value, {
        get: (obj, prop) => {
            if (
                typeof (prop) !== "symbol" && // accessing properties
                typeof (obj[prop]) === "undefined"
            ) {
                return obj.get(prop as string);

            } else {
                return obj[prop];
            }
        },

        set: (obj, prop, setValue) => {
            if (
                typeof (prop) !== "symbol" &&
                (
                    (prop as string).indexOf("$") === -1 &&
                    prop !== "onAdd" &&
                    prop !== "onRemove" &&
                    prop !== "onChange"
                )
            ) {
                obj.set(prop as string, setValue);

            } else {
                obj[prop] = setValue;
            }
            return true;
        },

        deleteProperty: (obj, prop) => {
            obj.delete(prop as string);
            return true;
        },
    });

    return value;
}

export class MapSchema<V=any> implements Map<string, V>, SchemaDecoderCallbacks {
    protected $changes: ChangeTree = new ChangeTree(this);

    protected $items: Map<string, V> = new Map<string, V>();
    protected $indexes: Map<number, string> = new Map<number, string>();

    protected $refId: number = 0;

    //
    // Decoding callbacks
    //
    public onAdd?: (item: V, key: string) => void;
    public onRemove?: (item: V, key: string) => void;
    public onChange?: (item: V, key: string) => void;

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<string, V> | any) {
        if (initialValues) {
            if (initialValues instanceof Map) {
                initialValues.forEach((v, k) => this.set(k, v));

            } else {
                for (const k in initialValues) {
                    this.set(k, initialValues[k]);
                }
            }
        }
    }

    /** Iterator */
    [Symbol.iterator](): IterableIterator<[string, V]> { return this.$items[Symbol.iterator](); }
    get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag] }

    set(key: string, value: V) {
        // get "index" for this value.
        const hasIndex = typeof(this.$changes.indexes[key]) !== "undefined";
        const index = (hasIndex)
            ? this.$changes.indexes[key]
            : this.$refId++;

        let operation: OPERATION = (hasIndex)
            ? OPERATION.REPLACE
            : OPERATION.ADD;

        const isRef = (value['$changes']) !== undefined;
        if (isRef) {
            (value['$changes'] as ChangeTree).setParent(
                this,
                this.$changes.root,
                index
            );
        }

        //
        // (encoding)
        // set a unique id to relate directly with this key/value.
        //
        if (!hasIndex) {
            this.$changes.indexes[key] = index;
            this.$indexes.set(index, key);

        } else if (
            isRef && // if is schema, force ADD operation if value differ from previous one.
            this.$items.get(key) !== value
        ) {
            operation = OPERATION.ADD;
        }

        this.$items.set(key, value);

        this.$changes.change(key, operation);

        return this;
    }

    get(key: string): V | undefined {
        return this.$items.get(key);
    }

    delete(key: string) {
        //
        // TODO: add a "purge" method after .encode() runs, to cleanup removed `$indexes`
        //
        // We don't remove $indexes to allow setting the same key in the same patch
        // (See "should allow to remove and set an item in the same place" test)
        //
        // // const index = this.$changes.indexes[key];
        // // this.$indexes.delete(index);

        this.$changes.delete(key);
        return this.$items.delete(key);
    }

    clear(isDecoding?: boolean) {
        // discard previous operations.
        this.$changes.discard(true, true);
        this.$changes.indexes = {};

        // clear previous indexes
        this.$indexes.clear();

        // flag child items for garbage collection.
        if (isDecoding && typeof (this.$changes.getType()) !== "string") {
            this.$items.forEach((item: V) => {
                this.$changes.root.removeRef(item['$changes'].refId);
            });
        }

        // clear items
        this.$items.clear();

        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });

        // touch all structures until reach root
        this.$changes.touchParents();
    }

    has (key: string) {
        return this.$items.has(key);
    }

    forEach(callbackfn: (value: V, key: string, map: Map<string, V>) => void) {
        this.$items.forEach(callbackfn);
    }

    entries () {
        return this.$items.entries();
    }

    keys () {
        return this.$items.keys();
    }

    values() {
        return this.$items.values();
    }

    get size () {
        return this.$items.size;
    }

    protected setIndex(index: number, key: string) {
        this.$indexes.set(index, key);
    }

    protected getIndex(index: number) {
        return this.$indexes.get(index);
    }

    protected getByIndex(index: number) {
        return this.$items.get(this.$indexes.get(index));
    }

    protected deleteByIndex(index: number) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }

    toJSON() {
        const map: any = {};

        this.forEach((value, key) => {
            map[key] = (typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value;
        });

        return map;
    }

    //
    // Decoding utilities
    //
    clone(isDecoding?: boolean): MapSchema<V> {
        let cloned: MapSchema;

        if (isDecoding) {
            // client-side
            cloned = Object.assign(new MapSchema(), this);

        } else {
            // server-side
            cloned = new MapSchema();
            this.forEach((value, key) => {
                if (value['$changes']) {
                    cloned.set(key, value['clone']());
                } else {
                    cloned.set(key, value);
                }
            })
        }

        return cloned;
    }

    triggerAll (): void {
        Schema.prototype.triggerAll.apply(this);
    }
}