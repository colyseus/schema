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

import { TextEncoder } from "util";
import type { Iterator } from "./decode";

export type BufferLike = number[] | ArrayBufferLike;

/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */

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
const _encoder = new TextEncoder();

const hasBufferByteLength = (typeof Buffer !== 'undefined' && Buffer.byteLength);

export const utf8Length = (hasBufferByteLength)
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
            else {
                i++;
                length += 4;
            }
        }
        return length;
    }

export function utf8Write(view: BufferLike, str: string, it: Iterator) {
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
    else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      view[it.offset] = 0xf0 | (c >> 18);
      view[it.offset+1] = 0x80 | (c >> 12 & 0x3f);
      view[it.offset+2] = 0x80 | (c >> 6 & 0x3f);
      view[it.offset+3] = 0x80 | (c & 0x3f);
      it.offset += 4;
    }
  }
}

export function int8(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 0xFF;
};

export function uint8(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 0xFF;
};

export function int16(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 0xFF;
    bytes[it.offset++] = (value >> 8) & 0xFF;
};

export function uint16(bytes: BufferLike, value: number, it: Iterator) {
    bytes[it.offset++] = value & 0xFF;
    bytes[it.offset++] = (value >> 8) & 0xFF;
};

export function int32(bytes: BufferLike, value: number, it: Iterator) {
  bytes[it.offset++] = value & 0xFF;
  bytes[it.offset++] = (value >> 8) & 0xFF;
  bytes[it.offset++] = (value >> 16) & 0xFF;
  bytes[it.offset++] = (value >> 24) & 0xFF;
};

export function uint32(bytes: BufferLike, value: number, it: Iterator) {
  bytes[it.offset++] = value & 0xFF;
  bytes[it.offset++] = (value >> 8) & 0xFF;
  bytes[it.offset++] = (value >> 16) & 0xFF;
  bytes[it.offset++] = (value >> 24) & 0xFF;
};

export function int64(bytes: BufferLike, value: number, it: Iterator) {
  const high = Math.floor(value / Math.pow(2, 32));
  const low = value >>> 0;
  uint32(bytes, low, it);
  uint32(bytes, high, it);
};

export function uint64(bytes: BufferLike, value: number, it: Iterator) {
  const high = (value / Math.pow(2, 32)) >> 0;
  const low = value >>> 0;
  uint32(bytes, low, it);
  uint32(bytes, high, it);
};

export function bigInt64(bytes: BufferLike, value: bigint, it: Iterator) {
  _int64[0] = BigInt.asIntN(64, value);
  int32(bytes, _int32[0], it);
  int32(bytes, _int32[1], it);
}

export function bigUint64(bytes: BufferLike, value: bigint, it: Iterator) {
  _int64[0] = BigInt.asIntN(64, value);
  int32(bytes, _int32[0], it);
  int32(bytes, _int32[1], it);
}

export function float32(bytes: BufferLike, value: number, it: Iterator) {
  _float32[0] = value;
  int32(bytes, _int32[0], it);
}

export function float64(bytes: BufferLike, value: number, it: Iterator) {
  _float64[0] = value;
  int32(bytes, _int32[_isLittleEndian ? 0 : 1], it);
  int32(bytes, _int32[_isLittleEndian ? 1 : 0], it);
}

// size: 1 - 8 bytes
export function varUint(bytes: BufferLike, value: number, it: Iterator) {
  value |= 0; // Infinity, -Infinity, NaN = 0
  do {
      let byte = value;
      value >>>= 7; // shift by 7 bits
      if(value) byte |= 0x80; // set continuation indicator bit
      bytes[it.offset++] = byte & 0xFF; // set byte
  } while(value !== 0);
}

// size: 1 - 8 bytes
export function varInt(bytes: BufferLike, value: number, it: Iterator) {
  varUint(bytes, (0 - (value < 0 ? 1 : 0)) ^ (value << 1), it); // zig zag encoding
}

// size 1 - n bytes (if the user aims to target platforms without BigInt implementation, BigInt.asUintN(64, self) may be necessary to limit the value to 64 bits)
export function varBigUint(bytes: BufferLike, value: bigint, it: Iterator) {
  do {
      let byte = value;
      value >>= 7n; // shift by 7 bits
      if(value) byte |= 0x80n; // set continuation indicator bit
      bytes[it.offset++] = Number(byte & 0xFFn); // set byte
  } while(value !== 0n);
}

// size 1 - n bytes (if the user aims to target platforms without BigInt implementation, BigInt.asIntN(64, self) may be necessary to limit the value to 64 bits)
export function varBigInt(bytes: BufferLike, value: bigint, it: Iterator) {
  varBigUint(bytes, (0n - (value < 0n ? 1n : 0n)) ^ (value << 1n), it); // zig zag encoding
}

/** Helper function to determine the amount of bytes that will be used by var(U)int */
export const calculateBytesVarInt = (value: number) => value === 0 ? 1 : Math.ceil((Math.floor(Math.log2(value)) + 1) / 7);

/** Helper function to determine the amount of bytes that will be used by varBig(U)int */
export const calculateBytesVarBigInt = (value: bigint) => {
  if (value === 0n) return 1;
  let bits = 0n;
  while(value > 0n) {
    value >>= 1n;
    ++bits;
  }
  return Number((bits + 6n) / 7n);
}

// 2 - 6 bytes
export function varFloat32(bytes: BufferLike, value: number, it: Iterator) {
  _float32[0] = value;

  // there are scenarios where splitting is unoptimal, however splitting usually is a bit more efficient
  varUint(bytes, _uint16[0], it); // mantissa (16 bits)
  varUint(bytes, _uint16[1], it); // mantissa (7 bits), exponent (8 bits), sign (1 bit)
}

// 2 - 10 bytes
export function varFloat64(bytes: BufferLike, value: number, it: Iterator) {
  _float64[0] = value;

  // there are scenarios where splitting is unoptimal, however splitting usually is a bit more efficient
  varUint(bytes, _uint32[0], it); // mantissa (32 bits)
  varUint(bytes, _uint32[1], it); // mantissa (20 bits), exponent (11 bits), sign (1 bit)
}

export function boolean(bytes: BufferLike, value: number, it: Iterator) {
  bytes[it.offset++] = value ? 1 : 0; // uint8
};

export function string(bytes: BufferLike, value: string, it: Iterator) {
  // encode `null` strings as empty.
  value ??= "";

  let length = utf8Length(value, "utf8");
  let size = 0;

  // fixstr
  if (length < 0x20) {
    bytes[it.offset++] = length | 0xa0;
    size = 1;
  }
  // str 8
  else if (length < 0x100) {
    bytes[it.offset++] = 0xd9;
    bytes[it.offset++] = length % 0xFF;
    size = 2;
  }
  // str 16
  else if (length < 0x10000) {
    bytes[it.offset++] = 0xda;
    uint16(bytes, length, it);
    size = 3;
  }
  // str 32
  else if (length < 0x100000000) {
    bytes[it.offset++] = 0xdb;
    uint32(bytes, length, it);
    size = 5;
  } else {
    throw new Error('String too long');
  }

  utf8Write(bytes, value, it);

  return size + length;
}

export function cstring(bytes: BufferLike, value: string = "", it: Iterator) {
  value ??= "";
  value += "\x00";
  if(bytes instanceof Uint8Array) {
    it.offset += _encoder.encodeInto(value, bytes.subarray(it.offset)).written;
  } else {
    const encoded = _encoder.encode(value);
    const len = encoded.length;
    for(let i = 0; i < len; ++i) bytes[it.offset++] = encoded[i]; // could probably also figure out if bytes has .set
  }
}

export function number(bytes: BufferLike, value: number, it: Iterator) {
  if (isNaN(value)) {
    return number(bytes, 0, it);

  } else if (!isFinite(value)) {
    return number(bytes, (value > 0) ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER, it);

  } else if (value !== (value|0)) {
    if (Math.abs(value) <= 3.4028235e+38) { // range check
        _float32[0] = value;
        if (Math.abs(Math.abs(_float32[0]) - Math.abs(value)) < 1e-4) { // precision check; adjust 1e-n (n = precision) to in-/decrease acceptable precision loss
            // now we know value is in range for f32 and has acceptable precision for f32
            bytes[it.offset++] = 0xca;
            float32(bytes, value, it);
            return 5;
        }
    }
      
    bytes[it.offset++] = 0xcb;
    float64(bytes, value, it);
    return 9;
  }

  if (value >= 0) {
    // positive fixnum
    if (value < 0x80) {
      bytes[it.offset++] = value & 0xFF; // uint8
      return 1;
    }

    // uint 8
    if (value < 0x100) {
      bytes[it.offset++] = 0xcc;
      bytes[it.offset++] = value & 0xFF; // uint8
      return 2;
    }

    // uint 16
    if (value < 0x10000) {
      bytes[it.offset++] = 0xcd;
      uint16(bytes, value, it);
      return 3;
    }

    // uint 32
    if (value < 0x100000000) {
      bytes[it.offset++] = 0xce;
      uint32(bytes, value, it);
      return 5;
    }

    // uint 64
    bytes[it.offset++] = 0xcf;
    uint64(bytes, value, it);
    return 9;
  } else {

    // negative fixnum
    if (value >= -0x20) {
      bytes[it.offset++] = 0xe0 | (value + 0x20);
      return 1;
    }

    // int 8
    if (value >= -0x80) {
      bytes[it.offset++] = 0xd0;
      int8(bytes, value, it);
      return 2;
    }

    // int 16
    if (value >= -0x8000) {
      bytes[it.offset++] = 0xd1;
      int16(bytes, value, it);
      return 3;
    }

    // int 32
    if (value >= -0x80000000) {
      bytes[it.offset++] = 0xd2;
      int32(bytes, value, it);
      return 5;
    }

    // int 64
    bytes[it.offset++] = 0xd3;
    int64(bytes, value, it);
    return 9;
  }
}
