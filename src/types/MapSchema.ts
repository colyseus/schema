import { ChangeTree } from "../ChangeTree";

type K = string; // TODO: allow to specify K generic on MapSchema.

export class MapSchema<V=any> {
    protected $changes: ChangeTree;
    protected $map: Map<string, V> = new Map<string, V>();

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (obj: Map<string, V> | any = {}) {
        if (obj instanceof Map) {
            obj.forEach((v, k) => this.set(k, v));

        } else {
            for (const k in obj) {
                this.set(k, obj[k]);
            }
        }

        Object.defineProperties(this, {
            $changes:     { value: undefined, enumerable: false, writable: true },

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

            _indexes: { value: new Map<string, number>(), enumerable: false, writable: true },
            _updateIndexes: {
                value: (allKeys) => {
                    let index: number = 0;

                    let indexes = new Map<string, number>();
                    for (let key of allKeys) {
                        indexes.set(key, index++);
                    }

                    this._indexes = indexes;
                }
            },
        });
    }

    set(key: K, value: V) {
        if (this.$changes) {
            this.$changes.change(key);
        }

        // const existing = this.has(key);
        // if (!existing) {
        // }

        this.$map.set(key, value);

        return this;
    }

    get(key: K) {
        return this.$map.get(key);
    }

    delete(key: K) {
        if (this.$changes) {
            this.$changes.delete(key);
        }

        return this.$map.delete(key);
    }

    clear() {
        this.$map.clear();
    }

    has (key: K) {
        return this.$map.has(key);
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void) {
        this.$map.forEach(callbackfn);
    }

    entries () {
        return this.$map.entries();
    }

    keys () {
        return this.$map.keys();
    }

    get size () {
        return this.$map.size;
    }

    //
    // Decoding utilities
    //
    clone: (isDecoding?: boolean) => MapSchema<V>;

    onAdd: (item: V, key: string) => void;
    onRemove: (item: V, key: string) => void;
    onChange: (item: V, key: string) => void;

    triggerAll: () => void;

    _indexes: Map<string, number>;
    _updateIndexes: (keys: string[]) => void;
}
