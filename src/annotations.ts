import { BYTE_UNCHANGED, BYTE_SYNC_OBJ } from './spec';
import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

export abstract class Sync {
    protected _offset: number = 0;
    protected _bytes: number[] = [];

    protected _changes: { [key: string]: any } = {};
    protected _changed: boolean = false;

    protected _parent: Sync;
    protected _parentField: string;

    public onChange?(field: string, value: any, previousValue: any);

    protected getFieldOffset(field: string, bytes = this._bytes, offset = 0) {
        const schema = this._schema;
        const fields = Object.keys(schema);
        const index = fields.indexOf(field);

        for (let i = 0; i < index; i++) {
            offset += bytes[offset] || 0;
        }

        return offset;
    }

    markAsChanged (field: string, value?: Sync | any) {
        this._changed = true;

        if (value) {
            if (Array.isArray(value._parentField)) {
                // used for MAP/ARRAY
                const fieldName = value._parentField[0];
                const fieldKey = value._parentField[1];

                if (!this._changes[fieldName]) {
                    this._changes[fieldName] = [];
                }

                this._changes[fieldName].push(fieldKey);

            } else if (value._parentField) {
                // used for direct type relationship
                this._changes[value._parentField] = value;

            } else {
                // basic types
                this._changes[field] = this[`_${field}`];
            }
        }

        if (this._parent && !this._parent._changed) {
            this._parent.markAsChanged(field, this);
        }
    }

    get _schema () {
        return (this.constructor as any)._schema;
    }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const schema = this._schema;

        for (const field in schema) {
            const isSyncObject = (bytes[it.offset] === BYTE_SYNC_OBJ);
            let isUnchanged = (bytes[it.offset] === BYTE_UNCHANGED);

            let type = schema[field];
            let value: any;

            if (isSyncObject) {
                it.offset++;
                isUnchanged = (bytes[it.offset] === BYTE_UNCHANGED);
            }

            if ((type as any)._schema && isSyncObject) {
                value = this[`_${field}`] || new type();
                value._parent = this;
                value.decode(bytes, it);

            } else if (Array.isArray(type) && !isUnchanged) {
                type = type[0];
                value = this[`_${field}`] || []

                const newLength = (bytes[it.offset++] & 0x0f);
                const numChanges = (bytes[it.offset++] & 0x0f);

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    value.splice(newLength);
                    // TODO: API to trigger data removal
                }

                for (let i = 0; i < numChanges; i++) {
                    const index = decode.int(bytes, it);

                    // it.offset = BYTE_SYNC_OBJ
                    // it.offset+1 = BYTE_UNCHANGED or actual change
                    if (bytes[it.offset+1] === BYTE_UNCHANGED) {
                        // skip unchanged entries
                        it.offset++;
                        continue;
                    }

                    const item = value[index] || new type();
                    item._parent = this;
                    item.decode(bytes, it);

                    if (value[index] === undefined) {
                        value.push(item);
                    }
                }

            } else if (type.map && !isUnchanged) {
                type = type.map;
                value = this[`_${field}`] || {};

                const length = (bytes[it.offset++] & 0x0f);

                for (let i = 0; i < length; i++) {
                    const key = decode.string(bytes, it);
                    const item = value[key] || new type();

                    item._parent = this;
                    item.decode(bytes, it);

                    if (value[key] === undefined) {
                        value[key] = item;
                    }
                }

            } else if (!isUnchanged) {
                const decodeFunc = decode[type];
                const decodeCheckFunc = decode[type + "Check"];

                if (decodeFunc && decodeCheckFunc(bytes, it)) {
                    value = decodeFunc(bytes, it);
                }

            } else {
                // unchanged, skip decoding it
                // console.log("field", field, "not changed. skip decoding it.", bytes[it.offset]);
                it.offset++;
            }

            if (!isUnchanged || isSyncObject) {
                if (this.onChange) {
                    this.onChange(field, value, this[`_${field}`]);
                }

                this[`_${field}`] = value;
            }
        }

        return this;
    }

    encode(encodedBytes = [], encodingOffset: number = 0) {
        encodedBytes.push(BYTE_SYNC_OBJ);

        // skip if nothing has changed
        if (!this._changed) {
            encodedBytes.push(BYTE_UNCHANGED); // skip
            return encodedBytes;
        }

        const schema = this._schema;
        for (const field in schema) {
            let bytes: number[] = [];

            const type = schema[field];
            const value = this._changes[field];

            // const fieldOffset = this.getFieldOffset(field, this._bytes || encodedBytes, encodingOffset);

            if (value === undefined) {
                // skip if no changes are made on this field
                // console.log(field, "haven't changed. skip it");
                bytes = [BYTE_UNCHANGED];

            } else if ((type as any)._schema) {
                // encode child object
                bytes = (value as Sync).encode(); // , fieldOffset

                // ensure parent is set
                // in case it was manually instantiated
                if (!value._parent) {
                    value._parent = this;
                    value._parentField = field;
                }

            } else if (Array.isArray(type)) {
                // encode Array of type

                // total of items in the array
                bytes.push(this[`_${field}`].length | 0xa0);

                // number of changed items
                bytes.push(value.length | 0xa0);

                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (!item._parent) {
                        item._parent = this;
                        item._parentField = [field, i];
                    }

                    encode.int(bytes, [], index);
                    bytes = bytes.concat(item.encode());
                }

            } else if (type.map) {
                // encode Map of type
                const keys = value;
                bytes.push(keys.length | 0x80);

                // console.log("ENCODE MAP, KEYS:", keys.length, keys);

                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const item = this[`_${field}`][key];

                    if (!item._parent) {
                        item._parent = this;
                        item._parentField = [field, key];
                    }

                    encode.string(bytes, [], key);
                    bytes = bytes.concat(item.encode());
                }

            } else {
                const encodeFunc = encode[type];

                if (!encodeFunc) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }

                encodeFunc(bytes, [], value);

                // let defers = []
                // const newLength = encodeFunc(bytes, defers, value);

                /*
                let deferIndex = 0;
                let deferWritten = 0;
                let nextOffset = -1;
                if (defers.length > 0) {
                    nextOffset = defers[0]._offset;
                }

                let defer, deferLength = 0, offset = 0;
                for (let j = 0, l = bytes.length; j < l; j++) {
                    bytes[deferWritten + j] = bytes[j];
                    if (j + 1 !== nextOffset) { continue; }
                    defer = defers[deferIndex];
                    deferLength = defer._length;
                    offset = deferWritten + nextOffset;
                    if (defer._bin) {
                        var bin = new Uint8Array(defer._bin);
                        for (let k = 0; k < deferLength; k++) {
                            bytes[offset + k] = bin[k];
                        }
                    } else if (defer._str) {
                        encode.utf8Write(bytes, bytes.length, defer._str);

                    } else if (defer._float !== undefined) {
                        bytes[offset] = defer._float;
                    }
                    deferIndex++;
                    deferWritten += deferLength;
                    if (defers[deferIndex]) {
                        nextOffset = defers[deferIndex]._offset;
                    }
                }
                */

            }

            // const previousLength = encodedBytes[encodingOffset + fieldOffset] || 0;
            // encodedBytes.splice(encodingOffset + fieldOffset, previousLength, ...bytes);

            encodedBytes = [...encodedBytes, ...bytes];
        }

        this._changed = false;
        this._changes = {};

        this._bytes = encodedBytes;
        return encodedBytes;
    }
}

export function sync (type: any) {
    return function (target: any, field: string) {
        const constructor = target.constructor;

        // static schema
        if (!constructor._schema) {
            constructor._schema = {};
        }
        constructor._schema[field] = type;

        const fieldCached = `_${field}`;
        Object.defineProperty(target, fieldCached, {
            enumerable: false,
            configurable: false,
            writable: true,
        });

        Object.defineProperty(target, field, {
            get: function () {
                return this._changes[field] || this[fieldCached];
            },
            set: function (this: Sync, value: any) {
                /**
                 * Create Proxy for array items
                 */
                if (Array.isArray(type) || type.map) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, value) => {
                            obj[prop] = value;

                            if (prop !== "length") {
                                if (!value._parent) {
                                    value._parent = this;
                                    value._parentField = [field, Number(prop)];
                                }

                                this.markAsChanged(field, value);
                            }

                            return true;
                        }
                    });
                }

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                this[fieldCached] = value;

                if (Array.isArray(constructor._schema[field])) {
                    for (let i = 0, l = value.length; i < l; i++) {
                        if (!value[i]._parent) {
                            value[i]._parent = this;
                            value[i]._parentField = [field, i];
                        }

                        this.markAsChanged(field, value[i]);
                    }

                } else if (constructor._schema[field].map) {
                    for (let key in value) {
                        if (!value[key]._parent) {
                            value[key]._parent = this;
                            value[key]._parentField = [field, key];
                        }

                        this.markAsChanged(field, value[key]);
                    }

                } else if (typeof(constructor._schema[field]) === "function") {
                    if (!value._parent) {
                        value._parent = this;
                        value._parentField = field;
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