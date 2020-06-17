import { ChangeTree } from "../changes/ChangeTree";

type K = string; // TODO: allow to specify K generic on MapSchema.

export class MapSchema<V=any> implements Map<string, V> {
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
    [Symbol.iterator](): IterableIterator<[K, V]> { return this.$items[Symbol.iterator](); }
    get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag] }

    set(key: K, value: V) {
        this.$items.set(key, value);

        const isRef = (value['$changes']) !== undefined;
        if (isRef) {
            (value['$changes'] as ChangeTree).setParent(this, this.$changes.root);
        }

        //
        // (encoding)
        // set a unique id to relate directly with this key/value.
        //
        if (!this.$changes.indexes[key]) {

            // set "index" for reference.
            const index = this.$refId++;

            // const index = (isRef)
            //     ? value['$changes'].refId
            //     : this.$refId++

            // console.log(`MapSchema#set() =>`, { isRef, key, index, value });

            this.$changes.indexes[key] = index;

            this.$indexes.set(index, key);
        }

        if (isRef) {
            value['$changes'].parentIndex = this.$changes.indexes[key];
        }

        this.$changes.change(key);

        return this;
    }

    get(key: K) {
        return this.$items.get(key);
    }

    delete(key: K) {
        this.$changes.delete(key);
        return this.$items.delete(key);
    }

    clear() {
        this.$items.clear();
    }

    has (key: K) {
        return this.$items.has(key);
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void) {
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

    protected getByIndex(index: number) {
        return this.$items.get(this.$indexes.get(index));
    }

    protected deleteByIndex(index: number) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }

    protected clearAllIndexes() {
        this.$changes.indexes = {};
        this.$indexes.clear();
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
            cloned.onAdd = this.onAdd;
            cloned.onRemove = this.onRemove;
            cloned.onChange = this.onChange;

        } else {
            // server-side
            const cloned = new MapSchema();
            this.forEach((value, key) => {
                if (typeof (value) === "object") {
                    cloned.set(key, value['clone']());
                } else {
                    cloned.set(key, value);
                }
            })
        }

        return cloned;
    }

    triggerAll (): void {
        if (!this.onAdd) { return; }
        this.forEach((value, key) => this.onAdd(value, key));
    }
}
