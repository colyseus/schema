import { encode, utf8Write } from "./msgpack/encode";
import { decode } from "./msgpack/decode";

export class Sync {
  _offset: number = 0;
  _bytes: number[] = [];

  getPatches() {
  }
}

export function sync (target: any, key: string) {
    if (!target._fields) { target._fields = []; }
    target._fields.push(key);

    Object.defineProperty(target, `_${key}`, {
        enumerable: false,
        configurable: false,
        writable: true,
    });

    Object.defineProperty(target, key, {
        get: function () {
            const fieldOffset = 0;
            return decode(this._bytes, fieldOffset);
        },

        set: function (this: any, value: any) {
            const fieldOffset = 0;
            const previousLength = this._bytes[fieldOffset] || 0;

            var bytes = []
            var defers = []

            const newLength = encode(bytes, defers, value);

            var deferIndex = 0;
            var deferWritten = 0;
            var nextOffset = -1;
            if (defers.length > 0) {
                nextOffset = defers[0]._offset;
            }

            var defer, deferLength = 0, offset = 0;
            for (var i = 0, l = bytes.length; i < l; i++) {
                bytes[deferWritten + i] = bytes[i];
                if (i + 1 !== nextOffset) { continue; }
                defer = defers[deferIndex];
                deferLength = defer._length;
                offset = deferWritten + nextOffset;
                if (defer._bin) {
                    var bin = new Uint8Array(defer._bin);
                    for (var j = 0; j < deferLength; j++) {
                        bytes[offset + j] = bin[j];
                    }
                } else if (defer._str) {
                    utf8Write(bytes, bytes.length, defer._str);

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
            this[`_${key}`] = value;
        },
        enumerable: true,
        configurable: false
    });
}