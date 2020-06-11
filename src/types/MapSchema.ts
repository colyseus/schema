import { ChangeTree } from "../changes/ChangeTree";

type K = string; // TODO: allow to specify K generic on MapSchema.

export class MapSchema<V=any> {
    protected $changes: ChangeTree;

    protected $items: Map<string, V> = new Map<string, V>();
    protected $indexes: Map<number, string> = new Map<number, string>();

    protected $refId: number;

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<string, V> | any) {
        Object.defineProperties(this, {
            $changes:     {
                value: new ChangeTree(this),
                enumerable: false,
                writable: true
            },
            $refId:       { value: 0,         enumerable: false, writable: true },

            onAdd:        { value: undefined, enumerable: false, writable: true },
            onRemove:     { value: undefined, enumerable: false, writable: true },
            onChange:     { value: undefined, enumerable: false, writable: true },

            clone: {
                value: (isDecoding?: boolean) => {
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
            },

            triggerAll: {
                value: () => {
                    if (!this.onAdd) { return; }
                    this.forEach((value, key) => this.onAdd(value, key));
                }
            },

            toJSON: {
                value: () => {
                    const map: any = {};

                    this.forEach((value, key) => {
                        map[key] = (typeof (value['toJSON']) === "function")
                            ? value['toJSON']()
                            : value;
                    });

                    return map;
                }
            },
        });

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
            const index = (isRef)
                ? value['$changes'].refId
                : this.$refId++

            // console.log("ROOT?", value['$changes'].root);
            console.log(`MapSchema#set() =>`, { isRef, key, index, value });

            this.$changes.indexes[key] = index;
            this.$indexes.set(index, key);
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

    get size () {
        return this.$items.size;
    }

    protected setIndex(index: number, key: string) {
        this.$indexes.set(index, key);
    }

    protected getByIndex(index: number) {
        return this.$items.get(this.$indexes.get(index));
    }

    //
    // Decoding utilities
    //
    clone: (isDecoding?: boolean) => MapSchema<V>;

    onAdd: (item: V, key: string) => void;
    onRemove: (item: V, key: string) => void;
    onChange: (item: V, key: string) => void;

    triggerAll: () => void;
}
