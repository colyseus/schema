import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

export class Sync {
    protected _offset: number = 0;
    protected _bytes: number[] = [];

    protected _fieldLengths: { [key: string]: number } = {};

    protected _changes: { [key: string]: any } = {};
    protected _changed: boolean = false;

    protected getFieldOffset(field: string) {
        const schema = (this.constructor as any)._schema;
        const fields = Object.keys(schema);
        const index = fields.indexOf(field);

        let offset = 0;
        for (let i = 0; i < index; i++) {
            offset += this._bytes[offset];
        }

        return offset;
    }

    decode(bytes) {
        const schema = (this.constructor as any)._schema;

        let iterator = { offset: 0 };
        for (const field in schema) {
            const decodeFunc = decode[schema[field]];

            if (!decodeFunc) {
                console.log("cannot decode", schema[field]);
                continue;
            }

            this[`_${field}`] = decodeFunc(bytes, iterator);
        }
    }

    encode() {
        // skip if nothing has changed
        if (!this._changed) { return; }

        const schema = (this.constructor as any)._schema;
        for (const field in schema) {
            const value = this._changes[field];
            const encodeFunc = encode[schema[field]];

            if (!encodeFunc) {
                console.log("cannot encode", schema[field]);
                continue;
            }

            // skip if no changes are made on this field
            if (!value) {
                console.log(field, "haven't changed empty. skip");
                continue;
            }

            const fieldOffset = this.getFieldOffset(field);
            const previousLength = this._bytes[fieldOffset] || 0;

            var bytes = []
            var defers = []

            const newLength = encodeFunc(bytes, defers, value);

            var deferIndex = 0;
            var deferWritten = 0;
            var nextOffset = -1;
            if (defers.length > 0) {
                nextOffset = defers[0]._offset;
            }

            var defer, deferLength = 0, offset = 0;
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

            this._bytes.splice(fieldOffset, previousLength, ...bytes);
        }

        this._changed = false;
        this._changes = {};

        return this._bytes;
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
                return this._changes[key] || this[fieldCached] || decode.decode(this._bytes, this.getFieldOffset(key));
            },

            set: function (this: Sync, value: any) {
                this._changed = true;
                this._changes[key] = value;
            },

            enumerable: true,
            configurable: false
        });
    }
}