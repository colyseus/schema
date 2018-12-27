import { BYTE_UNCHANGED } from './spec';
import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

export abstract class Sync {
    protected _offset: number = 0;
    protected _bytes: number[] = [];

    protected _fieldLengths: { [key: string]: number } = {};

    protected _changes: { [key: string]: any } = {};
    protected _changed: boolean = false;

    protected _parent: Sync;

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

    markAsChanged (child?: Sync) {
        this._changed = true;
        console.log(this.constructor.name, "HAVE PARENT?", typeof(this._parent));

        if (child) {
            const schema = this._schema;
            for (const field in schema) {
                if (this[`_${field}`] === child) {
                    this._changes[field] = child;
                    break;
                }
            }
        }

        if (this._parent && !this._parent._changed) {
            console.log("FLAG AS CHANGED", this.constructor.name);
            this._parent.markAsChanged(this);
        }
    }

    get _schema () {
        return (this.constructor as any)._schema;
    }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const schema = this._schema;

        for (const field in schema) {
            const type = schema[field];

            let value: any;
            const isUnchanged = (bytes[it.offset] === BYTE_UNCHANGED);

            if ((type as any)._schema) {
                value = new type();
                value._parent = this;
                console.log("SET PARENT FOR", value.constructor.name, "PARENT=", this.constructor.name );

                if (isUnchanged) {
                    console.log(`${type.name} is empty. leave it empty.`);
                    it.offset++;
                } else {
                    value.decode(bytes, it);
                }

            } else if (!isUnchanged) {
                const decodeFunc = decode[type];
                const decodeCheckFunc = decode[type + "Check"];

                if (decodeFunc && decodeCheckFunc(bytes, it)) {
                    value = decodeFunc(bytes, it);
                }
            } else {
                // unchanged, skip decoding it
                it.offset++;
            }

            if (this.onChange) {
                this.onChange(field, value, this[`_${field}`]);
            }

            this[`_${field}`] = value;
        }

        return this;
    }

    encode(encodedBytes = [], encodingOffset: number = 0) {
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
                console.log(field, "haven't changed. skip it");
                bytes = [BYTE_UNCHANGED];

            } else if ((type as any)._schema) {
                // encode child object
                bytes = (value as Sync).encode(); // , fieldOffset

                // ensure parent is set
                // in case it was manually instantiated
                if (!value._parent) {
                    value._parent = this;
                }

            } else {
                const encodeFunc = encode[type];

                if (!encodeFunc) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }

                let defers = []

                const newLength = encodeFunc(bytes, defers, value);

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
    return function (target: any, key: string) {
        const constructor = target.constructor;

        // static schema
        if (!constructor._schema) {
            constructor._schema = {};
        }
        constructor._schema[key] = type;

        const fieldCached = `_${key}`;
        Object.defineProperty(target, fieldCached, {
            enumerable: false,
            configurable: false,
            writable: true,
        });

        Object.defineProperty(target, key, {
            get: function () {
                return this._changes[key] || this[fieldCached] /*|| decode.decode(this._bytes, this.getFieldOffset(key))*/;
            },

            set: function (this: Sync, value: any) {
                this.markAsChanged();
                this._changes[key] = value;
                this[fieldCached] = value;
            },

            enumerable: true,
            configurable: false
        });
    }
}