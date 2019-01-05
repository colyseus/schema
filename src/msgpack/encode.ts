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

/**
 * msgpack implementation highly based on notepack.io
 * https://github.com/darrachequesne/notepack
 */

function utf8Length(str) {
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

export function utf8Write(view, offset, str) {
  var c = 0;
  for (var i = 0, l = str.length; i < l; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) {
      view[offset++] = c;
    }
    else if (c < 0x800) {
      view[offset++] = 0xc0 | (c >> 6);
      view[offset++] = 0x80 | (c & 0x3f);
    }
    else if (c < 0xd800 || c >= 0xe000) {
      view[offset++] = 0xe0 | (c >> 12);
      view[offset++] = 0x80 | (c >> 6 & 0x3f);
      view[offset++] = 0x80 | (c & 0x3f);
    }
    else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      view[offset++] = 0xf0 | (c >> 18);
      view[offset++] = 0x80 | (c >> 12 & 0x3f);
      view[offset++] = 0x80 | (c >> 6 & 0x3f);
      view[offset++] = 0x80 | (c & 0x3f);
    }
  }
}

export function encode(bytes, defers, value) {
  var type = typeof value, i = 0, l = 0, hi = 0, lo = 0, length = 0, size = 0;

  if (type === 'string') {
    length = utf8Length(value);

    // fixstr
    if (length < 0x20) {
      bytes.push(length | 0xa0);
      size = 1;
    }
    // str 8
    else if (length < 0x100) {
      bytes.push(0xd9, length);
      size = 2;
    }
    // str 16
    else if (length < 0x10000) {
      bytes.push(0xda, length >> 8, length);
      size = 3;
    }
    // str 32
    else if (length < 0x100000000) {
      bytes.push(0xdb, length >> 24, length >> 16, length >> 8, length);
      size = 5;
    } else {
      throw new Error('String too long');
    }
    defers.push({ _str: value, _length: length, _offset: bytes.length });
    return size + length;
  }
  if (type === 'number') {
    // TODO: encode to float 32?

    // float 64
    if (Math.floor(value) !== value || !isFinite(value)) {
      bytes.push(0xcb);
      defers.push({ _float: value, _length: 8, _offset: bytes.length });
      return 9;
    }

    if (value >= 0) {
      // positive fixnum
      if (value < 0x80) {
        bytes.push(value);
        return 1;
      }
      // uint 8
      if (value < 0x100) {
        bytes.push(0xcc, value);
        return 2;
      }
      // uint 16
      if (value < 0x10000) {
        bytes.push(0xcd, value >> 8, value);
        return 3;
      }
      // uint 32
      if (value < 0x100000000) {
        bytes.push(0xce, value >> 24, value >> 16, value >> 8, value);
        return 5;
      }
      // uint 64
      hi = (value / Math.pow(2, 32)) >> 0;
      lo = value >>> 0;
      bytes.push(0xcf, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo);
      return 9;
    } else {
      // negative fixnum
      if (value >= -0x20) {
        bytes.push(value);
        return 1;
      }
      // int 8
      if (value >= -0x80) {
        bytes.push(0xd0, value);
        return 2;
      }
      // int 16
      if (value >= -0x8000) {
        bytes.push(0xd1, value >> 8, value);
        return 3;
      }
      // int 32
      if (value >= -0x80000000) {
        bytes.push(0xd2, value >> 24, value >> 16, value >> 8, value);
        return 5;
      }
      // int 64
      hi = Math.floor(value / Math.pow(2, 32));
      lo = value >>> 0;
      bytes.push(0xd3, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo);
      return 9;
    }
  }
  if (type === 'object') {
    // nil
    if (value === null) {
      bytes.push(0xc0);
      return 1;
    }

    if (Array.isArray(value)) {
      length = value.length;

      // fixarray
      if (length < 0x10) {
        bytes.push(length | 0x90);
        size = 1;
      }
      // array 16
      else if (length < 0x10000) {
        bytes.push(0xdc, length >> 8, length);
        size = 3;
      }
      // array 32
      else if (length < 0x100000000) {
        bytes.push(0xdd, length >> 24, length >> 16, length >> 8, length);
        size = 5;
      } else {
        throw new Error('Array too large');
      }
      for (i = 0; i < length; i++) {
        size += encode(bytes, defers, value[i]);
      }
      return size;
    }

    // fixext 8 / Date
    if (value instanceof Date) {
      var time = value.getTime();
      hi = Math.floor(time / Math.pow(2, 32));
      lo = time >>> 0;
      bytes.push(0xd7, 0, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo);
      return 10;
    }

    if (value instanceof ArrayBuffer) {
      length = value.byteLength;

      // bin 8
      if (length < 0x100) {
        bytes.push(0xc4, length);
        size = 2;
      } else
      // bin 16
      if (length < 0x10000) {
        bytes.push(0xc5, length >> 8, length);
        size = 3;
      } else
      // bin 32
      if (length < 0x100000000) {
        bytes.push(0xc6, length >> 24, length >> 16, length >> 8, length);
        size = 5;
      } else {
        throw new Error('Buffer too large');
      }
      defers.push({ _bin: value, _length: length, _offset: bytes.length });
      return size + length;
    }

    if (typeof value.toJSON === 'function') {
      return encode(bytes, defers, value.toJSON());
    }

    var keys = [], key = '';

    var allKeys = Object.keys(value);
    for (i = 0, l = allKeys.length; i < l; i++) {
      key = allKeys[i];
      if (typeof value[key] !== 'function') {
        keys.push(key);
      }
    }
    length = keys.length;

    // fixmap
    if (length < 0x10) {
      bytes.push(length | 0x80);
      size = 1;
    }
    // map 16
    else if (length < 0x10000) {
      bytes.push(0xde, length >> 8, length);
      size = 3;
    }
    // map 32
    else if (length < 0x100000000) {
      bytes.push(0xdf, length >> 24, length >> 16, length >> 8, length);
      size = 5;
    } else {
      throw new Error('Object too large');
    }

    for (i = 0; i < length; i++) {
      key = keys[i];
      size += encode(bytes, defers, key);
      size += encode(bytes, defers, value[key]);
    }
    return size;
  }
  // false/true
  if (type === 'boolean') {
    bytes.push(value ? 0xc3 : 0xc2);
    return 1;
  }
  // fixext 1 / undefined
  if (type === 'undefined') {
    bytes.push(0xd4, 0, 0);
    return 3;
  }
  throw new Error('Could not encode');
}

export function string (bytes, defers, value) {
  let length = utf8Length(value);
  let size = 0;

  // fixstr
  if (length < 0x20) {
    bytes.push(length | 0xa0);
    size = 1;
  }
  // str 8
  else if (length < 0x100) {
    bytes.push(0xd9, length);
    size = 2;
  }
  // str 16
  else if (length < 0x10000) {
    bytes.push(0xda, length >> 8, length);
    size = 3;
  }
  // str 32
  else if (length < 0x100000000) {
    bytes.push(0xdb, length >> 24, length >> 16, length >> 8, length);
    size = 5;
  } else {
    throw new Error('String too long');
  }

  // defers.push({ _str: value, _length: length, _offset: bytes.length });
  utf8Write(bytes, bytes.length, value);

  return size + length;
}

export function int (bytes, defers, value) {
  let hi = 0, lo = 0;

  // float 64
  if (Math.floor(value) !== value || !isFinite(value)) {
    bytes.push(0xcb);
    defers.push({ _float: value, _length: 8, _offset: bytes.length });
    return 9;
  }

  if (value >= 0) {
    // positive fixnum
    if (value < 0x80) {
      bytes.push(value);
      return 1;
    }
    // uint 8
    if (value < 0x100) {
      bytes.push(0xcc, value);
      return 2;
    }
    // uint 16
    if (value < 0x10000) {
      bytes.push(0xcd, value >> 8, value);
      return 3;
    }
    // uint 32
    if (value < 0x100000000) {
      bytes.push(0xce, value >> 24, value >> 16, value >> 8, value);
      return 5;
    }
    // uint 64
    hi = (value / Math.pow(2, 32)) >> 0;
    lo = value >>> 0;
    bytes.push(0xcf, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo);
    return 9;
  } else {
    // negative fixnum
    if (value >= -0x20) {
      bytes.push(value);
      return 1;
    }
    // int 8
    if (value >= -0x80) {
      bytes.push(0xd0, value);
      return 2;
    }
    // int 16
    if (value >= -0x8000) {
      bytes.push(0xd1, value >> 8, value);
      return 3;
    }
    // int 32
    if (value >= -0x80000000) {
      bytes.push(0xd2, value >> 24, value >> 16, value >> 8, value);
      return 5;
    }
    // int 64
    hi = Math.floor(value / Math.pow(2, 32));
    lo = value >>> 0;
    bytes.push(0xd3, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo);
    return 9;
  }
}