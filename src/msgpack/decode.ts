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

function utf8Read(bytes, offset, length) {
  var string = '', chr = 0;
  for (var i = offset, end = offset + length; i < end; i++) {
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
    throw new Error('Invalid byte ' + byte.toString(16));
  }
  return string;
}


function _str (bytes, offset, length) {
  var value = utf8Read(bytes, offset, length);
  offset += length;
  return value;
};

export function decode(bytes, offset) {
  var prefix = bytes[offset++];
  var value, length = 0, type = 0, hi = 0, lo = 0;

  if (prefix < 0xc0) {
    // positive fixint
    if (prefix < 0x80) {
      return prefix;
    }
    // fixmap
    if (prefix < 0x90) {
      return this._map(prefix & 0x0f);
    }
    // fixarray
    if (prefix < 0xa0) {
      return this._array(prefix & 0x0f);
    }
    // fixstr
    return _str(bytes, offset, prefix & 0x1f);
  }

  // negative fixint
  if (prefix > 0xdf) {
    return (0xff - prefix + 1) * -1;
  }

  switch (prefix) {
    // nil
    case 0xc0:
      return null;
    // false
    case 0xc2:
      return false;
    // true
    case 0xc3:
      return true;

    // bin
    case 0xc4:
      length = bytes[offset];
      offset += 1;
      return this._bin(length);
    case 0xc5:
      length = bytes[offset];
      offset += 2;
      return this._bin(length);
    case 0xc6:
      length = bytes[offset];
      offset += 4;
      return this._bin(length);

    // ext
    case 0xc7:
      length = bytes[offset];
      type = bytes[offset + 1];
      offset += 2;
      return [type, this._bin(length)];
    case 0xc8:
      length = bytes[offset];
      type = bytes[offset + 2];
      offset += 3;
      return [type, this._bin(length)];
    case 0xc9:
      length = bytes[offset];
      type = bytes[offset + 4];
      offset += 5;
      return [type, this._bin(length)];

    // float
    case 0xca:
      value = bytes[offset];
      offset += 4;
      return value;
    case 0xcb:
      value = bytes[offset];
      offset += 8;
      return value;

    // uint
    case 0xcc:
      value = bytes[offset];
      offset += 1;
      return value;
    case 0xcd:
      value = bytes[offset];
      offset += 2;
      return value;
    case 0xce:
      value = bytes[offset];
      offset += 4;
      return value;
    case 0xcf:
      hi = bytes[offset] * Math.pow(2, 32);
      lo = bytes[offset + 4];
      offset += 8;
      return hi + lo;

    // int
    case 0xd0:
      value = bytes[offset];
      offset += 1;
      return value;
    case 0xd1:
      value = bytes[offset];
      offset += 2;
      return value;
    case 0xd2:
      value = bytes[offset];
      offset += 4;
      return value;
    case 0xd3:
      hi = bytes[offset] * Math.pow(2, 32);
      lo = bytes[offset + 4];
      offset += 8;
      return hi + lo;

    // fixext
    case 0xd4:
      type = bytes[offset];
      offset += 1;
      if (type === 0x00) {
        offset += 1;
        return void 0;
      }
      return [type, this._bin(1)];
    case 0xd5:
      type = bytes[offset];
      offset += 1;
      return [type, this._bin(2)];
    case 0xd6:
      type = bytes[offset];
      offset += 1;
      return [type, this._bin(4)];
    case 0xd7:
      type = bytes[offset];
      offset += 1;
      if (type === 0x00) {
        hi = bytes[offset] * Math.pow(2, 32);
        lo = bytes[offset + 4];
        offset += 8;
        return new Date(hi + lo);
      }
      return [type, this._bin(8)];
    case 0xd8:
      type = bytes[offset];
      offset += 1;
      return [type, this._bin(16)];

    // str
    case 0xd9:
      length = bytes[offset];
      offset += 1;
      return this._str(length);
    case 0xda:
      length = bytes[offset];
      offset += 2;
      return this._str(length);
    case 0xdb:
      length = bytes[offset];
      offset += 4;
      return this._str(length);

    // array
    case 0xdc:
      length = bytes[offset];
      offset += 2;
      return this._array(length);
    case 0xdd:
      length = bytes[offset];
      offset += 4;
      return this._array(length);

    // map
    case 0xde:
      length = bytes[offset];
      offset += 2;
      return this._map(length);
    case 0xdf:
      length = bytes[offset];
      offset += 4;
      return this._map(length);
  }

  throw new Error('Could not parse');
}