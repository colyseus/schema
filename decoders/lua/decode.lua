local spec = require('spec')
local exports = {}

--[[
function utf8Read(bytes, offset, length) {
  var string = '', chr = 0
  for (var i = offset, end = offset + length; i < end; i++) {
    var byte = bytes[i];
    if ((byte & 0x80) == 0x00) {
      string += String.fromCharCode(byte);
      continue;
    }
    if ((byte & 0xe0) == 0xc0) {
      string += String.fromCharCode(
        ((byte & 0x1f) << 6) |
        (bytes[++i] & 0x3f)
      );
      continue;
    }
    if ((byte & 0xf0) == 0xe0) {
      string += String.fromCharCode(
        ((byte & 0x0f) << 12) |
        ((bytes[++i] & 0x3f) << 6) |
        ((bytes[++i] & 0x3f) << 0)
      );
      continue;
    }
    if ((byte & 0xf8) == 0xf0) {
      chr = ((byte & 0x07) << 18) |
        ((bytes[++i] & 0x3f) << 12) |
        ((bytes[++i] & 0x3f) << 6) |
        ((bytes[++i] & 0x3f) << 0);
      if (chr >= 0x010000) { -- surrogate pair
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

function _str (bytes, it, length) 
  var value = utf8Read(bytes, it.offset, length)
  it.offset = it.offset + length
  return value
end
]]--

---
-- Shift a number's bits to the right.
-- Roughly equivalent to (x / (2^bits)).
-- @param x  The number to shift (number).
-- @param bits  Number of positions to shift by (number).
-- @return  A number.
local function brshift(x, bits)
	return floor(floor(x) / (2^bits))
end

function int8 (bytes, it) 
    return brshift(bit.rshift(uint8(bytes, it), 24), 24)
end

function uint8 (bytes, it) 
    local int = bytes[it.offset]
    it.offset = it.offset + 1
    return int
end

function int16 (bytes, it) 
    return brshift(bit.rshift(uint16(bytes, it), 16), 16)
end

function uint16 (bytes, it) 
    local n1 = bytes[it.offset]
    it.offset = it.offset + 1

    local n2 = bytes[it.offset]
    it.offset = it.offset + 1

    return bit.rshift(bit.bor(n1, n2), 8)
end

function int32 (bytes, it) 
    local n1 = bytes[it.offset]
    it.offset = it.offset + 1

    local n2 = bytes[it.offset]
    it.offset = it.offset + 1

    local n3 = bytes[it.offset]
    it.offset = it.offset + 1

    local n4 = bytes[it.offset]
    it.offset = it.offset + 1

    return bit.bor(n1, bit.rshift(n2, 8), bit.rshift(n3, 16), bit.rshift(n4, 24))
end

function uint32 (bytes, it) 
    -- TODO:
    -- return int32(bytes, it) >>> 0
    return int32(bytes, it)
end

--[[
function string (bytes, it) 
  local prefix = bytes[it.offset]
  it.offset = it.offset + 1
  return _str(bytes, it, prefix & 0x1f)
end
]]--

function stringCheck (bytes, it) 
  local prefix = bytes[it.offset]
  return (
    -- fixstr
    (prefix < 192 and prefix > 160) or
    -- str 8
    prefix == 217 or
    -- str 16
    prefix == 218 or
    -- str 32
    prefix == 219
  )
end

function number (bytes, it) 
  local prefix = bytes[it.offset]
  it.offset = it.offset + 1

  if (prefix < 128) then
    -- positive fixint
    return prefix

  elseif (prefix == 202) then
    -- float 32
    return readFloat32(bytes, it)

  elseif (prefix == 203) then
    -- float 64
    return readFloat64(bytes, it)

  elseif (prefix == 204) then
    -- uint 8
    return uint8(bytes, it)

  elseif (prefix == 205) then
    -- uint 16
    return uint16(bytes, it)

  elseif (prefix == 206) then
    -- uint 32
    return uint32(bytes, it)

  elseif (prefix == 207) then
    -- uint 64
    local hi = bytes[it.offset] * math.pow(2, 32)
    local lo = bytes[it.offset + 4]
    it.offset = it.offset + 8
    return hi + lo

  elseif (prefix == 208) then
    -- int 8
    return int8(bytes, it)

  elseif (prefix == 209) then
    -- int 16
    return int16(bytes, it)

  elseif (prefix == 210) then
    -- int 32
    return int32(bytes, it)

  elseif (prefix == 211) then
    -- int 64
    local hi = bytes[it.offset] * math.pow(2, 32)
    local lo = bytes[it.offset + 4]
    it.offset = it.offset + 8
    return hi + lo

  elseif (prefix > 223) then
    -- negative fixint
    return (255 - prefix + 1) * -1
  end
end

function numberCheck (bytes, it) 
  local prefix = bytes[it.offset]
  return (prefix < 128 or (prefix >= 202 and prefix <= 211))
end

function arrayCheck (bytes, it) 
  return bytes[it.offset] < 160
end

function nilCheck (bytes, it) 
  return bytes[it.offset] == spec.NIL
end

function indexChangeCheck (bytes, it) 
  return bytes[it.offset] == spec.INDEX_CHANGE
end

return {
    int8 = int8,
    uint8 = uint8,
    int16 = int16,
    uint1 = uint1,
    int32 = int32,
    uint32 = uint32,
    number = number,
    stringCheck = stringCheck,
    numberCheck = numberCheck,
    arrayCheck = arrayCheck,
    nilCheck = nilCheck,
    indexChangeCheck  = indexChangeCheck,
}