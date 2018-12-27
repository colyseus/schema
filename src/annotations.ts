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
        const schema = (this.constructor as any)._schema;
        const fields = Object.keys(schema);
        const index = fields.indexOf(field);

        for (let i = 0; i < index; i++) {
            offset += bytes[offset] || 0;
        }

        return offset;
    }

    markAsChanged () {
        this._changed = true;

        if (this._parent) {
            this._parent.markAsChanged();
        }
    }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const schema = (this.constructor as any)._schema;

        for (const field in schema) {
            const type = schema[field];
            let value: any;

            if ((type as any)._schema) {
                value = new type();
                value._parent = this;

                if (bytes[it.offset] === 0x00) {
                    console.log(`${type.name} is empty. leave it empty.`);
                    it.offset++;
                } else {
                    value.decode(bytes, it);
                }

            } else {
                const decodeFunc = decode[type];
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

    encode(encodedBytes = [], encodingOffset: number = 0) {
        // skip if nothing has changed
        if (!this._changed) {
            console.log(this.constructor.name, "haven't changed. skip.");
            encodedBytes.push(0x00); // skip
            return encodedBytes;
        }

        const schema = (this.constructor as any)._schema;
        for (const field in schema) {
            const value = this._changes[field];
            let bytes: number[] = [];

            if (!value) {
                // skip if no changes are made on this field
                console.log(field, "haven't changed empty. skip");
                continue;
            }

            // const fieldOffset = this.getFieldOffset(field, this._bytes || encodedBytes, encodingOffset);
            const type = schema[field];

            // encode child object
            if ((type as any)._schema) {
                bytes = (value as Sync).encode(); // , fieldOffset

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
            },

            enumerable: true,
            configurable: false
        });
    }
}