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
 * Length thresholds (UTF-8 bytes) of the decode paths, measured on Node 20/22
 * for ASCII, accented and CJK text (bench/realworld-results.md, "Round 2 — D"):
 *  - below `APPLY_MIN`, pure ASCII: one fixed-arity `String.fromCharCode`
 *    ({@link asciiShort});
 *  - otherwise a loop collects UTF-16 units and builds the string with one
 *    `String.fromCharCode.apply` — flat, never a cons string, and no dead
 *    intermediate string per character as a `+=` loop leaves;
 *  - from `TEXT_DECODER_MIN`, pure ASCII only (one scan, early exit on the
 *    first high bit): `TextDecoder` (~130 ns flat). Its non-ASCII path is
 *    2× slower than the loop up to several hundred bytes, hence the gate;
 *  - from `APPLY_MAX`: `TextDecoder` regardless — an `apply` argument list
 *    that long risks the stack limit (without one, the loop applies in pieces).
 */
const APPLY_MIN = 13;
const TEXT_DECODER_MIN = 48;
const APPLY_MAX = 4096;

function isAscii(bytes: BufferLike, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (bytes[i] > 0x7f) return false;
  }
  return true;
}

const fromCharCode = String.fromCharCode;

/**
 * `n` (1..12) ASCII bytes at `o` as one flat string: a single allocation,
 * 2-5x faster than building it from an array of units.
 */
function asciiShort(b: BufferLike, o: number, n: number): string {
  switch (n) {
    case 1: return fromCharCode(b[o]);
    case 2: return fromCharCode(b[o], b[o + 1]);
    case 3: return fromCharCode(b[o], b[o + 1], b[o + 2]);
    case 4: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    case 5: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4]);
    case 6: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]);
    case 7: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
    case 8: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    case 9: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7], b[o + 8]);
    case 10: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7], b[o + 8], b[o + 9]);
    case 11: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7], b[o + 8], b[o + 9], b[o + 10]);
    default: return fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7], b[o + 8], b[o + 9], b[o + 10], b[o + 11]);
  }
}

function utf8ReadApply(bytes: BufferLike, it: Iterator, length: number) {
  const units = new Array<number>(length < APPLY_MAX ? length : APPLY_MAX);
  let string = '', n = 0, chr = 0;
  for (var i = it.offset, end = it.offset + length; i < end; i++) {
    if (n >= APPLY_MAX) { // only reached without a TextDecoder
      string += fromCharCode.apply(null, units);
      n = 0;
    }
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
    // (do not throw: a malformed string must not crash the peer)
    console.error('decode.utf8Read(): Invalid byte ' + byte + ' at offset ' + i + '. Skip to end of string: ' + (it.offset + length));
    break;
  }
  it.offset += length;
  if (n !== units.length) units.length = n;
  const tail = fromCharCode.apply(null, units);
  return (string === '') ? tail : string + tail;
}

function utf8Read(bytes: BufferLike, it: Iterator, length: number) {
  // boundary check
  if (length > bytes.length - it.offset) { length = bytes.length - it.offset; }

  if (length < APPLY_MIN) {
    if (length <= 0) {
      it.offset += length;
      return '';
    }
    if (isAscii(bytes, it.offset, it.offset + length)) {
      const string = asciiShort(bytes, it.offset, length);
      it.offset += length;
      return string;
    }
  } else if (
    textDecoder !== undefined && (bytes as Uint8Array).subarray !== undefined &&
    (length >= APPLY_MAX || (length >= TEXT_DECODER_MIN && isAscii(bytes, it.offset, it.offset + length)))
  ) {
    const string = textDecoder.decode((bytes as Uint8Array).subarray(it.offset, it.offset + length));
    it.offset += length;
    return string;
  }
  return utf8ReadApply(bytes, it, length);
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