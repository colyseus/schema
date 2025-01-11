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

import { SWITCH_TO_STRUCTURE } from "./spec";
import type { BufferLike } from "./encode";
import { TextDecoder } from "util";

// force little endian to facilitate decoding on multiple implementations
const _isLittleEndian = true;  // new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
const _convoBuffer = new ArrayBuffer(8);
const _uint8 = new Uint8Array(_convoBuffer);
const _uint16 = new Uint16Array(_convoBuffer);
const _uint32 = new Uint32Array(_convoBuffer);
const _uint64 = new BigUint64Array(_convoBuffer);
const _int8 = new Int8Array(_convoBuffer);
const _int16 = new Int16Array(_convoBuffer);
const _int32 = new Int32Array(_convoBuffer);
const _int64 = new BigInt64Array(_convoBuffer);
const _float32 = new Float32Array(_convoBuffer);
const _float64 = new Float64Array(_convoBuffer);
const _decoder = new TextDecoder();

/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */

export interface Iterator { offset: number; }

export function utf8Read(bytes: BufferLike, it: Iterator, length: number) {
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

    console.error('Invalid byte ' + byte.toString(16));
    // (do not throw error to avoid server/client from crashing due to hack attemps)
    // throw new Error('Invalid byte ' + byte.toString(16));
  }
  it.offset += length;
  return string;
}

export function int8(bytes: BufferLike, it: Iterator) {
  return uint8(bytes, it) << 24 >> 24;
};

export function uint8(bytes: BufferLike, it: Iterator) {
  return bytes[it.offset++];
};

export function int16(bytes: BufferLike, it: Iterator) {
  return uint16(bytes, it) << 16 >> 16;
};

export function uint16(bytes: BufferLike, it: Iterator) {
  return bytes[it.offset++] | bytes[it.offset++] << 8;
};

export function int32(bytes: BufferLike, it: Iterator) {
  return bytes[it.offset++] | bytes[it.offset++] << 8 | bytes[it.offset++] << 16 | bytes[it.offset++] << 24;
};

export function uint32(bytes: BufferLike, it: Iterator) {
  return int32(bytes, it) >>> 0;
};

export function float32(bytes: BufferLike, it: Iterator) {
  _int32[0] = int32(bytes, it);
  return _float32[0];
}

export function float64(bytes: BufferLike, it: Iterator) {
  _int32[_isLittleEndian ? 0 : 1] = int32(bytes, it);
  _int32[_isLittleEndian ? 1 : 0] = int32(bytes, it);
  return _float64[0];
}

export function int64(bytes: BufferLike, it: Iterator) {
  const low = uint32(bytes, it);
  const high = int32(bytes, it) * Math.pow(2, 32);
  return high + low;
};

export function uint64(bytes: BufferLike, it: Iterator) {
  const low = uint32(bytes, it);
  const high = uint32(bytes, it) * Math.pow(2, 32);
  return high + low;
};

export function bigInt64(bytes: BufferLike, it: Iterator) {
  _int32[0] = int32(bytes, it);
  _int32[1] = int32(bytes, it);
  return _int64[0];
}

export function bigUint64(bytes: BufferLike, it: Iterator) {
  _int32[0] = int32(bytes, it);
  _int32[1] = int32(bytes, it);
  return _uint64[0];
}

export function varUint(bytes: BufferLike, it: Iterator): number {
  let value = 0, shift = 0;
  while(bytes[it.offset] & 0x80) { // check continuation indicator bit
    value |= (bytes[it.offset++] & 0x7f) << shift; // read 7 bits
    shift += 7; // next 7 bits
  }
  value |= (bytes[it.offset++] & 0x7f) << shift; // read remaining bits
  return value;
}

export function varInt(bytes: BufferLike, it: Iterator): number {
  const value = varUint(bytes, it);
  return (0 - (value & 1)) ^ (value >>> 1); // zig zag decoding
}

export function varBigUint(bytes: BufferLike, it: Iterator): bigint {
  let value = 0n, shift = 0n;
  while(bytes[it.offset] & 0x80) { // check continuation indicator bit
    value |= BigInt((bytes[it.offset++] & 0x7f)) << shift; // read 7 bits
    shift += 7n; // next 7 bits
  }
  value |= BigInt((bytes[it.offset++] & 0x7f)) << shift; // read remaining bits
  return value;
}

export function varBigInt(bytes: BufferLike, it: Iterator): bigint {
  const value = varBigUint(bytes, it);
  return (0n - (value & 1n)) ^ (value >> 1n); // zig zag decoding
}

export function varFloat32(bytes: BufferLike, it: Iterator) {
  _uint16[0] = varUint(bytes, it);
  _uint16[1] = varUint(bytes, it);
  return _float32[0];
}

export function varFloat64(bytes: BufferLike, it: Iterator) {
  _uint32[0] = varUint(bytes, it);
  _uint32[1] = varUint(bytes, it);
  return _float64[0];
}

export function boolean(bytes: BufferLike, it: Iterator) {
  return uint8(bytes, it) > 0;
};

export function string(bytes: BufferLike, it: Iterator) {
  const prefix = bytes[it.offset++];
  let length: number;

  if (prefix < 0xc0) {
    // fixstr
    length = prefix & 0x1f;

  } else if (prefix === 0xd9) {
    length = uint8(bytes, it);

  } else if (prefix === 0xda) {
    length = uint16(bytes, it);

  } else if (prefix === 0xdb) {
    length = uint32(bytes, it);
  }

  return utf8Read(bytes, it, length);
}

export function cstring(bytes: BufferLike, it: Iterator) {
  // should short circuit if buffer length can't be determined for some reason so we don't just infinitely loop
  const len = (bytes as Buffer | ArrayBuffer).byteLength ?? (bytes as number[]).length;
  if (len === undefined) throw TypeError("Unable to determine length of 'BufferLike' " + bytes.toString());
  let start = it.offset;
  while (it.offset < len && bytes[it.offset++] !== 0x00) { }; // nop, fast search for terminator
  return _decoder.decode(new Uint8Array((bytes as Buffer | Uint8Array)?.subarray?.(start, it.offset - 1) ?? bytes.slice(start, it.offset - 1))); // ignore terminator
}

export function stringCheck(bytes: BufferLike, it: Iterator) {
  const prefix = bytes[it.offset];
  return (
    // fixstr
    (prefix < 0xc0 && prefix > 0xa0) ||
    // str 8
    prefix === 0xd9 ||
    // str 16
    prefix === 0xda ||
    // str 32
    prefix === 0xdb
  );
}

export function number(bytes: BufferLike, it: Iterator) {
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

export function numberCheck(bytes: BufferLike, it: Iterator) {
  const prefix = bytes[it.offset];
  // positive fixint - 0x00 - 0x7f
  // float 32        - 0xca
  // float 64        - 0xcb
  // uint 8          - 0xcc
  // uint 16         - 0xcd
  // uint 32         - 0xce
  // uint 64         - 0xcf
  // int 8           - 0xd0
  // int 16          - 0xd1
  // int 32          - 0xd2
  // int 64          - 0xd3
  return (
    prefix < 0x80 ||
    (prefix >= 0xca && prefix <= 0xd3)
  );
}

export function arrayCheck(bytes: BufferLike, it: Iterator) {
  return bytes[it.offset] < 0xa0;

  // const prefix = bytes[it.offset] ;

  // if (prefix < 0xa0) {
  //   return prefix;

  // // array
  // } else if (prefix === 0xdc) {
  //   it.offset += 2;

  // } else if (0xdd) {
  //   it.offset += 4;
  // }

  // return prefix;
}

export function switchStructureCheck(bytes: BufferLike, it: Iterator) {
  return (
    // previous byte should be `SWITCH_TO_STRUCTURE`
    bytes[it.offset - 1] === SWITCH_TO_STRUCTURE &&
    // next byte should be a number
    (bytes[it.offset] < 0x80 || (bytes[it.offset] >= 0xca && bytes[it.offset] <= 0xd3))
  );
}