// @ts-nocheck

/**
 * Copyright (c) 2018 Endel Dreyer
 * Copyright (c) 2014 Ion Drive Software Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE
 */

import type { Iterator } from "./decode.js";
import { writeNumber, writeString } from "./varint.js";

export type BufferLike = ArrayLike<number> & { [index: number]: number };

/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */

// `undefined` where the global is missing (old browsers / exotic runtimes):
// `writeString` then keeps the char loop for every length.
/** The global `TextEncoder`, typed locally so no Node type leaks into the public declarations. */
interface Utf8Encoder { encodeInto(src: string, dst: Uint8Array): { read: number; written: number } }
let textEncoder: Utf8Encoder | undefined;
// @ts-ignore
try { textEncoder = new TextEncoder(); } catch (e) { }

/**
 * Native UTF-8 write of `str` at `it.offset` (no length prefix). When the
 * string does not fit, `it.offset` is advanced by the full UTF-8 length so
 * it lands past `bytes.byteLength` and the caller's overflow check fires —
 * `encodeInto` itself stops at the last whole character that fits.
 */
function utf8EncodeInto(bytes: Uint8Array, str: string, it: Iterator) {
    const r = textEncoder.encodeInto(str, (it.offset === 0) ? bytes : bytes.subarray(it.offset));
    if (r.read < str.length) {
        it.offset += utf8Length(str, "utf8");
        return;
    }
    it.offset += r.written;
}

// force little endian to facilitate decoding on multiple implementations
const _isLittleEndian = true;  // new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
const _convoBuffer = new ArrayBuffer(8);
const _int32 = new Int32Array(_convoBuffer);
const _float32 = new Float32Array(_convoBuffer);
const _float64 = new Float64Array(_convoBuffer);
const _int64 = new BigInt64Array(_convoBuffer);

const hasBufferByteLength = (typeof Buffer !== 'undefined' && Buffer.byteLength);

const utf8Length: (str: string, _?: any) => number = (hasBufferByteLength)
    ? Buffer.byteLength // node
    : function (str: string, _?: any) {
        var c = 0, length = 0;
        for (var i = 0, l = str.length; i < l; i++) {
            c = str.charCodeAt(i);
            if (c < 0x80) {
                length += 1;
            }
            else if (c < 0x800) {
                length += 2;
            }
            else if (c < 0xd800 || c >= 0xe000) {
                length += 3;
            }
            else if (c < 0xdc00 && i + 1 < l && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
                i++;
                length += 4;
            }
            else {
                length += 3; // lone surrogate rides as U+FFFD, like Buffer.byteLength / TextEncoder
            }
        }
        return length;
    }

function utf8Write(view: BufferLike, str: string, it: Iterator) {
  var c = 0;
  for (var i = 0, l = str.length; i < l; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) {
      view[it.offset++] = c;
    }
    else if (c < 0x800) {
      view[it.offset] = 0xc0 | (c >> 6);
      view[it.offset + 1] = 0x80 | (c & 0x3f);
      it.offset += 2;
    }
    else if (c < 0xd800 || c >= 0xe000) {
      view[it.offset] = 0xe0 | (c >> 12);
      view[it.offset+1] = 0x80 | (c >> 6 & 0x3f);
      view[it.offset+2] = 0x80 | (c & 0x3f);
      it.offset += 3;
    }
    else if (c < 0xdc00 && i + 1 < l && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      view[it.offset] = 0xf0 | (c >> 18);
      view[it.offset+1] = 0x80 | (c >> 12 & 0x3f);
      view[it.offset+2] = 0x80 | (c >> 6 & 0x3f);
      view[it.offset+3] = 0x80 | (c & 0x3f);
      it.offset += 4;
    }
    else {
      // lone surrogate: U+FFFD, the same bytes `TextEncoder` / `Buffer` produce
      // (the length prefix and the body then agree, whichever path wrote them)
      view[it.offset] = 0xef;
      view[it.offset+1] = 0xbf;
      view[it.offset+2] = 0xbd;
      it.offset += 3;
    }
  }
}

function int8(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 255;
};

function uint8(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 255;
};

function int16(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 255;
    bytes[it.offset++] = (value >> 8) & 255;
};

function uint16(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 255;
    bytes[it.offset++] = (value >> 8) & 255;
};

function int32(bytes: BufferLike, value: number, it: Iterator) {
  bytes[it.offset++] = value & 255;
  bytes[it.offset++] = (value >> 8) & 255;
  bytes[it.offset++] = (value >> 16) & 255;
  bytes[it.offset++] = (value >> 24) & 255;
};

function uint32(bytes: BufferLike, value: number, it: Iterator) {
  const b4 = value >> 24;
  const b3 = value >> 16;
  const b2 = value >> 8;
  const b1 = value;
  bytes[it.offset++] = b1 & 255;
  bytes[it.offset++] = b2 & 255;
  bytes[it.offset++] = b3 & 255;
  bytes[it.offset++] = b4 & 255;
};

function int64(bytes: BufferLike, value: number, it: Iterator) {
  const high = Math.floor(value / Math.pow(2, 32));
  const low = value >>> 0;
  uint32(bytes, low, it);
  uint32(bytes, high, it);
};

function uint64(bytes: BufferLike, value: number, it: Iterator) {
  const high = (value / Math.pow(2, 32)) >> 0;
  const low = value >>> 0;
  uint32(bytes, low, it);
  uint32(bytes, high, it);
};

function bigint64(bytes: BufferLike, value: bigint, it: Iterator) {
    _int64[0] = BigInt.asIntN(64, value);
    int32(bytes, _int32[0], it);
    int32(bytes, _int32[1], it);
}

function biguint64(bytes: BufferLike, value: bigint, it: Iterator) {
    _int64[0] = BigInt.asIntN(64, value);
    int32(bytes, _int32[0], it);
    int32(bytes, _int32[1], it);
}

function float32(bytes: BufferLike, value: number, it: Iterator) {
  _float32[0] = value;
  int32(bytes, _int32[0], it);
}

function float64(bytes: BufferLike, value: number, it: Iterator) {
  _float64[0] = value;
  int32(bytes, _int32[_isLittleEndian ? 0 : 1], it);
  int32(bytes, _int32[_isLittleEndian ? 1 : 0], it);
}

function boolean(bytes: BufferLike, value: number, it: Iterator) {
  bytes[it.offset++] = value ? 1 : 0; // uint8
};

export const encode = {
    int8,
    uint8,
    int16,
    uint16,
    int32,
    uint32,
    int64,
    uint64,
    bigint64,
    biguint64,
    float32,
    float64,
    boolean,
    // v6: `uvarint(len) + utf8` strings and the msgpack-shaped dynamic number
    string: writeString,
    number: writeNumber,
    utf8Write,
    utf8Length,
    utf8EncodeInto,
    textEncoder, // resolved above, before this literal
}