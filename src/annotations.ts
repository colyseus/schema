import { END_OF_STRUCTURE } from './spec';
import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

type SchemaType = (
    "string" |
    "int" |
    (typeof Sync)[] |
    typeof Sync |
    { map?: typeof Sync }
);
type Schema = { [field: string]: SchemaType };

export abstract class Sync {
    static _schema: Schema;
    static _indexes: {[field: string]: number};

    protected $changes: { [key: string]: any } = {};
    protected $changed: boolean = false;

    protected $parent: Sync;
    protected $parentField: string;

    public onChange?(field: string, value: any, previousValue: any);

    markAsChanged (field: string, value?: Sync | any) {
        this.$changed = true;

        if (value) {
            if (Array.isArray(value.$parentField)) {
                // used for MAP/ARRAY
                const fieldName = value.$parentField[0];
                const fieldKey = value.$parentField[1];

                if (!this.$changes[fieldName]) {
                    this.$changes[fieldName] = [];
                }

                if (
                    fieldKey !== undefined &&
                    this.$changes[fieldName].indexOf(fieldKey) === -1 // do not store duplicates of changed fields
                ) {
                    this.$changes[fieldName].push(fieldKey);
                }

            } else if (value.$parentField) {
                // used for direct type relationship
                this.$changes[value.$parentField] = value;

            } else {
                // basic types
                this.$changes[field] = this[`_${field}`];
            }
        }

        if (this.$parent) {
            this.$parent.markAsChanged(field, this);
        }
    }

    get _schema () {
        return (this.constructor as typeof Sync)._schema;
    }
    get _indexes () {
        return (this.constructor as typeof Sync)._indexes;
    }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const schema = this._schema;
        const indexes = this._indexes;

        const fieldsByIndex = {}
        Object.keys(indexes).forEach((key) => {
            const value = indexes[key];
            fieldsByIndex[value] = key
        })

        const totalBytes = bytes.length;

        while (it.offset < totalBytes) {
            const index = bytes[it.offset++];
            const field = fieldsByIndex[index];

            if (index === END_OF_STRUCTURE) {
                // reached end of strucutre. skip.
                break;
            }

            let type = schema[field];
            let value: any;

            if ((type as any)._schema) {
                value = this[`_${field}`] || new (type as any)();
                value.$parent = this;
                value.decode(bytes, it);

            } else if (Array.isArray(type)) {
                type = type[0];
                value = this[`_${field}`] || []

                const newLength = decode.int(bytes, it);
                const numChanges = decode.int(bytes, it);

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    value.splice(newLength);
                    // TODO: API to trigger data removal
                }

                for (let i = 0; i < numChanges; i++) {
                    const index = decode.int(bytes, it);

                    const item = value[index] || new (type as any)();
                    item.$parent = this;
                    item.decode(bytes, it);

                    if (value[index] === undefined) {
                        value.push(item);
                    }
                }

            } else if ((type as any).map) {
                type = (type as any).map;
                value = this[`_${field}`] || {};

                const length = decode.int(bytes, it);

                for (let i = 0; i < length; i++) {
                    const hasMapIndex = decode.intCheck(bytes, it);

                    const key = (hasMapIndex)
                        ? Object.keys(value)[decode.int(bytes, it)]
                        : decode.string(bytes, it);

                    const item = value[key] || new (type as any)();

                    item.$parent = this;
                    item.decode(bytes, it);

                    if (value[key] === undefined) {
                        value[key] = item;
                    }
                }

            } else {
                const decodeFunc = decode[type as string];
                const decodeCheckFunc = decode[type + "Check"];

                if (decodeFunc && decodeCheckFunc(bytes, it)) {
                    value = decodeFunc(bytes, it);
                }
            }

            if (this.onChange) {
                this.onChange(field, value, this[`_${field}`]);
            }

            this[`_${field}`] = value;
        }

        return this;
    }

    encode(root: boolean = true, encodedBytes = []) {
        // skip if nothing has changed
        if (!this.$changed) {
            return encodedBytes;
        }

        const schema = this._schema;
        const indexes = this._indexes;

        for (const field in this.$changes) {
            let bytes: number[] = [];

            const type = schema[field];
            const value = this.$changes[field];
            const fieldIndex = indexes[field];

            // skip unchagned fields
            if (value === undefined) {
                continue;
            }

            if ((type as any)._schema) {
                encode.int(bytes, [], fieldIndex);

                // encode child object
                bytes = bytes.concat((value as Sync).encode(false));

                // ensure parent is set
                // in case it was manually instantiated
                if (!value.$parent) {
                    value.$parent = this;
                    value.$parentField = field;
                }

            } else if (Array.isArray(type)) {
                encode.int(bytes, [], fieldIndex);

                // total of items in the array
                encode.int(bytes, [], this[`_${field}`].length);

                // number of changed items
                encode.int(bytes, [], value.length);

                // encode Array of type
                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (!item.$parent) {
                        item.$parent = this;
                        item.$parentField = [field, i];
                    }

                    encode.int(bytes, [], index);
                    bytes = bytes.concat(item.encode(false));
                }

            } else if ((type as any).map) {
                encode.int(bytes, [], fieldIndex);

                // encode Map of type
                const keys = value;
                encode.int(bytes, [], keys.length)

                for (let i = 0; i < keys.length; i++) {
                    let key = keys[i];
                    const item = this[`_${field}`][key];
                    const mapItemIndex = this[`_${field}MapIndex`][key];

                    if (mapItemIndex !== undefined) {
                        key = mapItemIndex;
                        encode.int(bytes, [], key);

                    } else {
                        encode.string(bytes, [], key);
                        this[`_${field}MapIndex`][key] = Object.keys(this[`_${field}`]).indexOf(key);
                    }

                    if (!item.$parent) {
                        item.$parent = this;
                        item.$parentField = [field, key];
                    }

                    bytes = bytes.concat(item.encode(false));
                }

            } else {
                encode.int(bytes, [], fieldIndex);

                const encodeFunc = encode[type as string];
                if (!encodeFunc) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }

                encodeFunc(bytes, [], value);
            }

            encodedBytes = [...encodedBytes, ...bytes];
        }

        // flag end of Sync object structure
        if (!root) {
            encodedBytes.push(END_OF_STRUCTURE);
        }

        this.$changed = false;
        this.$changes = {};

        return encodedBytes;
    }
}

export function sync (type: SchemaType) {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Sync;

        /*
         * static schema
         */
        if (!constructor._schema) {
            constructor._schema = {};
            constructor._indexes = {};
        }
        constructor._indexes[field] = Object.keys(constructor._schema).length;
        constructor._schema[field] = type;

        const isArray = Array.isArray(type);
        const isMap = (type as any).map;

        const fieldCached = `_${field}`;

        Object.defineProperty(target, fieldCached, {
            enumerable: false,
            configurable: false,
            writable: true,
        });

        if (isMap) {
            target[`${fieldCached}MapIndex`] = {};
        }

        Object.defineProperty(target, field, {
            get: function () {
                return this[fieldCached];
            },

            set: function (this: Sync, value: any) {
                /**
                 * Create Proxy for array items
                 */
                if (isArray || isMap) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, value) => {
                            if (prop !== "length") {
                                // ensure new value has a parent
                                if (!value.$parent) {
                                    const key = (isArray) ? Number(prop) : prop;
                                    value.$parent = this;
                                    value.$parentField = [field, key];
                                }

                                this.markAsChanged(field, value);
                            }

                            obj[prop] = value;

                            return true;
                        },

                        deleteProperty: (obj, prop) => {
                            console.log("DELETE PROPERTY", prop);
                            delete obj[prop];
                            return true;
                        },
                    });
                }

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                this[fieldCached] = value;

                if (Array.isArray(constructor._schema[field])) {
                    const length = value.length;

                    if (length === 0) {
                        // FIXME: this is a bit confusing.
                        // Needed to allow encoding an empty array.
                        this.markAsChanged(field, { $parentField: [field] });
                        return;
                    }

                    for (let i = 0; i < length; i++) {
                        if (!value[i].$parent) {
                            value[i].$parent = this;
                            value[i].$parentField = [field, i];
                        }
                        this.markAsChanged(field, value[i]);
                    }

                } else if ((constructor._schema[field] as any).map) {
                    for (let key in value) {
                        if (!value[key].$parent) {
                            value[key].$parent = this;
                            value[key].$parentField = [field, key];
                        }

                        this.markAsChanged(field, value[key]);
                    }

                } else if (typeof(constructor._schema[field]) === "function") {
                    if (!value.$parent) {
                        value.$parent = this;
                        value.$parentField = field;
                    }
                    this.markAsChanged(field, value);

                } else {
                    this.markAsChanged(field, value);
                }
            },

            enumerable: true,
            configurable: false
        });
    }
}