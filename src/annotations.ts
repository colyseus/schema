import { END_OF_STRUCTURE, NIL, INDEX_CHANGE } from './spec';
import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

type PrimitiveType =
    "string" |
    "number" |
    "int8" |
    "uint8" |
    "int16" |
    "uint16" |
    "int32" |
    "uint32" |
    "int64" |
    "uint64" |
    typeof Sync;

type SchemaType = ( PrimitiveType | PrimitiveType[] | { map?: typeof Sync });
type Schema = { [field: string]: SchemaType };

function encodePrimitiveType (type: string, bytes: number[], value: any) {
    const encodeFunc = encode[type];
    if (encodeFunc) {
        encodeFunc(bytes, value);
        return true;

    } else {
        return false;
    }
}

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    const decodeFunc = decode[type as string];

    if (decodeFunc) {
         return decodeFunc(bytes, it);

    } else {
        return null;
    }
}

export interface DataChange {
    field: string;
    value: any;
    previousValue: any;
}

export abstract class Sync {
    static _schema: Schema;
    static _indexes: {[field: string]: number};

    protected $changes: { [key: string]: any } = {};
    protected $changed: boolean = false;

    protected $parent: Sync;
    protected $parentField: string | (string | number)[];
    protected $parentIndexChange: number;

    public onChange?(changes: DataChange[]);

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
        const changes: DataChange[] = [];

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

                const valueRef = this[`_${field}`] || [];
                value = valueRef.slice(0);

                const newLength = decode.number(bytes, it);
                const numChanges = decode.number(bytes, it);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    value.splice(newLength);
                    // TODO: API to trigger data removal
                }

                for (let i = 0; i < numChanges; i++) {
                    const newIndex = decode.number(bytes, it);

                    if (decode.nilCheck(bytes, it)) {
                        // const item = this[`_${field}`][newIndex];
                        // TODO: trigger `onRemove` on Sync object being removed.
                        it.offset++;
                        continue;
                    }

                    let indexChangedFrom: number;
                    if (decode.indexChangeCheck(bytes, it)) {
                        // it.offset++;
                        decode.uint8(bytes, it);
                        indexChangedFrom = decode.number(bytes, it);
                        hasIndexChange = true;
                    }

                    if ((type as any).prototype instanceof Sync) {
                        let item;

                        if (hasIndexChange && indexChangedFrom === undefined && newIndex !== undefined) {
                            item = new (type as any)();

                        } else if (indexChangedFrom !== undefined) {
                            item = valueRef[indexChangedFrom];

                        } else if (newIndex !== undefined) {
                            item = valueRef[newIndex]
                        }

                        if (!item) {
                            item = new (type as any)();
                        }

                        item.$parent = this;
                        item.decode(bytes, it);

                        value[newIndex] = item;
                    } else {
                        value[newIndex] = decodePrimitiveType(type as string, bytes, it);
                    }
                }


            } else if ((type as any).map) {
                type = (type as any).map;
                value = this[`_${field}`] || {};

                const length = decode.number(bytes, it);

                for (let i = 0; i < length; i++) {
                    const hasMapIndex = decode.numberCheck(bytes, it);

                    const key = (hasMapIndex)
                        ? Object.keys(value)[decode.number(bytes, it)]
                        : decode.string(bytes, it);

                    const item = value[key] || new (type as any)();

                    item.$parent = this;
                    item.decode(bytes, it);

                    if (value[key] === undefined) {
                        value[key] = item;
                    }
                }

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
            }

            if (this.onChange) {
                changes.push({
                    field,
                    value,
                    previousValue: this[`_${field}`]
                });
            }

            this[`_${field}`] = value;
        }

        if (this.onChange && changes.length > 0) {
            this.onChange(changes);
        }

        return this;
    }

    encode(root: boolean = true, encodedBytes = []) {
        const endStructure = () => {
            if (!root) {
                encodedBytes.push(END_OF_STRUCTURE);
            }
        }

        // skip if nothing has changed
        if (!this.$changed) {
            endStructure();
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
                encode.number(bytes, fieldIndex);

                // encode child object
                bytes = bytes.concat((value as Sync).encode(false));

                // ensure parent is set
                // in case it was manually instantiated
                if (!value.$parent) {
                    value.$parent = this;
                    value.$parentField = field;
                }

            } else if (Array.isArray(type)) {
                encode.number(bytes, fieldIndex);

                // total of items in the array
                encode.number(bytes, this[`_${field}`].length);

                // number of changed items
                encode.number(bytes, value.length);

                // encode Array of type
                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (typeof(type[0]) !== "string") { // is array of Sync
                        encode.number(bytes, index);

                        if (item === undefined) {
                            encode.uint8(bytes, NIL);
                            continue;
                        }

                        if (item.$parentIndexChange >= 0) {
                            encode.uint8(bytes, INDEX_CHANGE);
                            encode.number(bytes, item.$parentIndexChange);
                            item.$parentIndexChange = undefined; // reset
                        }

                        if (!item.$parent) {
                            item.$parent = this;
                            item.$parentField = [field, i];
                        }

                        bytes = bytes.concat(item.encode(false));

                    } else {
                        encode.number(bytes, i);

                        if (!encodePrimitiveType(type[0] as string, bytes, index)) {
                            console.log("cannot encode", schema[field]);
                            continue;
                        }
                    }
                }

            } else if ((type as any).map) {
                encode.number(bytes, fieldIndex);

                // encode Map of type
                const keys = value;
                encode.number(bytes, keys.length)

                for (let i = 0; i < keys.length; i++) {
                    let key = keys[i];
                    const item = this[`_${field}`][key];
                    const mapItemIndex = this[`_${field}MapIndex`][key];

                    if (mapItemIndex !== undefined) {
                        key = mapItemIndex;
                        encode.number(bytes, key);

                    } else {
                        encode.string(bytes, key);
                        this[`_${field}MapIndex`][key] = Object.keys(this[`_${field}`]).indexOf(key);
                    }

                    if (!item.$parent) {
                        item.$parent = this;
                        item.$parentField = [field, key];
                    }

                    bytes = bytes.concat(item.encode(false));
                }

            } else {
                encode.number(bytes, fieldIndex);

                if (!encodePrimitiveType(type as string, bytes, value)) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }
            }

            encodedBytes = [...encodedBytes, ...bytes];
        }

        // flag end of Sync object structure
        endStructure();

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
                 * Create Proxy for array or map items
                 */
                if (isArray || isMap) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, setValue) => {
                            if (prop !== "length") {
                                // ensure new value has a parent
                                const key = (isArray) ? Number(prop) : prop;

                                if (setValue.$parentField && setValue.$parentField[1] !== key) {
                                    setValue.$parentIndexChange = setValue.$parentField[1];
                                }

                                setValue.$parent = this;
                                setValue.$parentField = [field, key];

                                this.markAsChanged(field, setValue);

                            } else if (setValue !== obj[prop]) {
                                // console.log("SET NEW LENGTH:", setValue);
                                // console.log("PREVIOUS LENGTH: ", obj[prop]);
                            }

                            obj[prop] = setValue;

                            return true;
                        },

                        deleteProperty: (obj, prop) => {
                            const previousValue = obj[prop];
                            delete obj[prop];

                            // ensure new value has a parent
                            if (previousValue.$parent) {
                                previousValue.$parent.markAsChanged(field, previousValue);
                            }

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
                    // directly assigning an array of items as value.
                    const length = value.length;

                    if (length === 0) {
                        // FIXME: this is a bit confusing.
                        // Needed to allow encoding an empty array.
                        this.markAsChanged(field, { $parentField: [field] });
                        return;
                    }

                    for (let i = 0; i < length; i++) {
                        if (value[i] instanceof Sync) {
                            value[i].$parent = this;
                            value[i].$parentField = [field, i];
                        }
                        this.markAsChanged(field, value[i]);
                    }

                } else if ((constructor._schema[field] as any).map) {
                    // directly assigning a map
                    for (let key in value) {
                        value[key].$parent = this;
                        value[key].$parentField = [field, key];

                        this.markAsChanged(field, value[key]);
                    }

                } else if (typeof(constructor._schema[field]) === "function") {
                    // directly assigning a `Sync` object
                    value.$parent = this;
                    value.$parentField = field;
                    this.markAsChanged(field, value);

                } else {
                    // directly assigning a primitive type
                    this.markAsChanged(field, value);
                }
            },

            enumerable: true,
            configurable: false
        });
    }
}