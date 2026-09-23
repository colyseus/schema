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

import type { BufferLike } from "./encode.js";
import { readString } from "./varint.js";

/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */

export interface Iterator { offset: number; }

// force little endian to facilitate decoding on multiple implementations
const _isLittleEndian = true;  // new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
const _convoBuffer = new ArrayBuffer(8);

const _int32 = new Int32Array(_convoBuffer);
const _float32 = new Float32Array(_convoBuffer);
const _float64 = new Float64Array(_convoBuffer);
const _uint64 = new BigUint64Array(_convoBuffer);
const _int64 = new BigInt64Array(_convoBuffer);

// `ignoreBOM: true` keeps a leading U+FEFF, as the char loop does. `undefined`
// where the global is missing: every length then takes the JS paths.
let textDecoder: TextDecoder | undefined;
// @ts-ignore
try { textDecoder = new TextDecoder("utf-8", { ignoreBOM: true }); } catch (e) { }

/**
 * Length thresholds (UTF-8 bytes) of the three decode paths, measured on
 * Node 20 for ASCII, accented and CJK text (bench/realworld-results.md,
 * "Round 2 — D"):
 *  - below `APPLY_MIN`: the `+=` char loop (no allocation beyond the string);
 *  - from `APPLY_MIN`: the same loop collects UTF-16 units and builds the
 *    string with one `String.fromCharCode.apply` — flat, never a cons
 *    string (the `+=` loop returns a ConsString from 13 chars on, whose
 *    flattening the consumer pays later: a map key hash, a compare);
 *  - from `TEXT_DECODER_MIN`, pure ASCII only (one scan, early exit on the
 *    first high bit): `TextDecoder` (~130 ns flat). Its non-ASCII path is
 *    2× slower than the loop up to several hundred bytes, hence the gate;
 *  - from `TEXT_DECODER_FORCE`: `TextDecoder` regardless — an `apply`
 *    argument list that long risks the stack limit.
 */
const APPLY_MIN = 16;
const TEXT_DECODER_MIN = 48;
const TEXT_DECODER_FORCE = 4096;

function isAscii(bytes: BufferLike, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (bytes[i] > 0x7f) return false;
  }
  return true;
}

function utf8ReadApply(bytes: BufferLike, it: Iterator, length: number) {
  const units = new Array<number>(length);
  let n = 0, chr = 0;
  for (var i = it.offset, end = it.offset + length; i < end; i++) {
    var byte = bytes[i];
    if ((byte & 0x80) === 0x00) {
      units[n++] = byte;
      continue;
    }
    if ((byte & 0xe0) === 0xc0) {
      units[n++] = ((byte & 0x1f) << 6) | (bytes[++i] & 0x3f);
      continue;
    }
    if ((byte & 0xf0) === 0xe0) {
      units[n++] = ((byte & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | ((bytes[++i] & 0x3f) << 0);
      continue;
    }
    if ((byte & 0xf8) === 0xf0) {
      chr = ((byte & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | ((bytes[++i] & 0x3f) << 0);
      if (chr >= 0x010000) { // surrogate pair
        chr -= 0x010000;
        units[n++] = (chr >>> 10) + 0xD800;
        units[n++] = (chr & 0x3FF) + 0xDC00;
      } else {
        units[n++] = chr;
      }
      continue;
    }
    console.error('decode.utf8Read(): Invalid byte ' + byte + ' at offset ' + i + '. Skip to end of string: ' + (it.offset + length));
    break;
  }
  it.offset += length;
  if (n !== length) units.length = n;
  return String.fromCharCode.apply(null, units);
}

function utf8Read(bytes: BufferLike, it: Iterator, length: number) {
  // boundary check
  if (length > bytes.length - it.offset) { length = bytes.length - it.offset; }

  if (length >= APPLY_MIN) {
    if (textDecoder !== undefined && (bytes as Uint8Array).subarray !== undefined) {
      if (length >= TEXT_DECODER_FORCE || (length >= TEXT_DECODER_MIN && isAscii(bytes, it.offset, it.offset + length))) {
        const string = textDecoder.decode((bytes as Uint8Array).subarray(it.offset, it.offset + length));
        it.offset += length;
        return string;
      }
      return utf8ReadApply(bytes, it, length);
    }
    if (length < TEXT_DECODER_FORCE) { return utf8ReadApply(bytes, it, length); }
    // no TextDecoder and a huge string: the char loop below is the safe path
  }

  var string = '', chr = 0;
  for (var i = it.offset, end = it.offset + length; i < end; i++) {
    var byte = bytes[i];
    if ((byte & 0x80) === 0x00) {
      string += String.fromCharCode(byte);
      continue;
    }
    if ((byte & 0xe0) === 0xc0) {
      string += String.fromCharCode(
        ((byte & 0x1f) << 6) |
        (bytes[++i] & 0x3f)
      );
      continue;
    }
    if ((byte & 0xf0) === 0xe0) {
      string += String.fromCharCode(
        ((byte & 0x0f) << 12) |
        ((bytes[++i] & 0x3f) << 6) |
        ((bytes[++i] & 0x3f) << 0)
      );
      continue;
    }
    if ((byte & 0xf8) === 0xf0) {
      chr = ((byte & 0x07) << 18) |
        ((bytes[++i] & 0x3f) << 12) |
        ((bytes[++i] & 0x3f) << 6) |
        ((bytes[++i] & 0x3f) << 0);
      if (chr >= 0x010000) { // surrogate pair
        chr -= 0x010000;
        string += String.fromCharCode((chr >>> 10) + 0xD800, (chr & 0x3FF) + 0xDC00);
      } else {
        string += String.fromCharCode(chr);
      }
      continue;
    }

    // (do not throw error to avoid server/client from crashing due to hack attemps)
    // throw new Error('Invalid byte ' + byte.toString(16));

    console.error('decode.utf8Read(): Invalid byte ' + byte + ' at offset ' + i + '. Skip to end of string: ' + (it.offset + length));
    break;
  }
  it.offset += length;
  return string;
}

function int8 (bytes: BufferLike, it: Iterator) {
    return uint8(bytes, it) << 24 >> 24;
};

function uint8 (bytes: BufferLike, it: Iterator) {
    return bytes[it.offset++];
};

function int16 (bytes: BufferLike, it: Iterator) {
    return uint16(bytes, it) << 16 >> 16;
};

function uint16 (bytes: BufferLike, it: Iterator) {
    return bytes[it.offset++] | bytes[it.offset++] << 8;
};

function int32 (bytes: BufferLike, it: Iterator) {
    return bytes[it.offset++] | bytes[it.offset++] << 8 | bytes[it.offset++] << 16 | bytes[it.offset++] << 24;
};

function uint32 (bytes: BufferLike, it: Iterator) {
    return int32(bytes, it) >>> 0;
};

function float32 (bytes: BufferLike, it: Iterator) {
    _int32[0] = int32(bytes, it);
    return _float32[0];
};

function float64 (bytes: BufferLike, it: Iterator) {
    _int32[_isLittleEndian ? 0 : 1] = int32(bytes, it);
    _int32[_isLittleEndian ? 1 : 0] = int32(bytes, it);
    return _float64[0];
};

function int64(bytes: BufferLike, it: Iterator) {
  const low = uint32(bytes, it);
  const high = int32(bytes, it) * Math.pow(2, 32);
  return high + low;
};

function uint64(bytes: BufferLike, it: Iterator) {
    const low = uint32(bytes, it);
    const high = uint32(bytes, it) * Math.pow(2, 32);
    return high + low;
};

function bigint64(bytes: BufferLike, it: Iterator) {
    _int32[0] = int32(bytes, it);
    _int32[1] = int32(bytes, it);
    return _int64[0];
}

function biguint64(bytes: BufferLike, it: Iterator) {
    _int32[0] = int32(bytes, it);
    _int32[1] = int32(bytes, it);
    return _uint64[0];
}

function boolean (bytes: BufferLike, it: Iterator) {
    return uint8(bytes, it) > 0;
};

function number (bytes: BufferLike, it: Iterator) {
  const prefix = bytes[it.offset++];

  if (prefix < 0x80) {
    // positive fixint
    return prefix;

  } else if (prefix === 0xca) {
    // float 32
    return float32(bytes, it);

  } else if (prefix === 0xcb) {
    // float 64
    return float64(bytes, it);

  } else if (prefix === 0xcc) {
    // uint 8
    return uint8(bytes, it);

  } else if (prefix === 0xcd) {
    // uint 16
    return uint16(bytes, it);

  } else if (prefix === 0xce) {
    // uint 32
    return uint32(bytes, it);

  } else if (prefix === 0xcf) {
    // uint 64
    return uint64(bytes, it);

  } else if (prefix === 0xd0) {
    // int 8
    return int8(bytes, it);

  } else if (prefix === 0xd1) {
    // int 16
    return int16(bytes, it);

  } else if (prefix === 0xd2) {
    // int 32
    return int32(bytes, it);

  } else if (prefix === 0xd3) {
    // int 64
    return int64(bytes, it);

  } else if (prefix > 0xdf) {
    // negative fixint
    return (0xff - prefix + 1) * -1
  }
};

export const decode = {
    utf8Read,
    int8,
    uint8,
    int16,
    uint16,
    int32,
    uint32,
    float32,
    float64,
    int64,
    uint64,
    bigint64,
    biguint64,
    boolean,
    // v6: `uvarint(len) + utf8` strings
    string: readString,
    number,
};