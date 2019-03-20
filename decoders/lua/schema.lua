--
-- @colyseus/schema decoder for LUA
-- Do not modify this file unless you know exactly what you're doing.
--
-- This file is part of Colyseus: https://github.com/colyseus/colyseus
--
local bit = bit or require('bit')
local ldexp = math.ldexp or mathx.ldexp

-- START SPEC --
local spec = {
    END_OF_STRUCTURE = 193,
    NIL = 192,
    INDEX_CHANGE = 212,
}
-- END SPEC --

-- START DECODE --
function utf8_read(bytes, offset, length) 
  local str = ""
  local chr = 0

  local len = offset + length

  for i = offset, len - 1 do
    repeat 
        local byte = bytes[i]

        if (bit.band(byte, 0x80) == 0x00) then
            str = str .. string.char(byte)
            break
        end

        if (bit.band(byte, 0xe0) == 0xc0) then
            local b1 = bytes[i]
            i = i + 1

            str = str .. string.char(
                bit.bor(
                    bit.arshift(bit.band(byte, 0x1f), 6),
                    bit.band(bytes[b1], 0x3f)
                )
            )
            break
        end

        if (bit.band(byte, 0xf0) == 0xe0) then
            local b1 = bytes[i]
            i = i + 1
            local b2 = bytes[i]
            i = i + 1

            str = str .. string.char(
                bit.bor(
                    bit.arshift(bit.band(byte, 0x0f), 12),
                    bit.arshift(bit.band(bytes[b1], 0x3f), 6),
                    bit.arshift(bit.band(bytes[b2], 0x3f), 0)
                )
            )
            break
        end

        if (bit.band(byte, 0xf8) == 0xf0) then
            local b1 = bytes[i]
            i = i + 1
            local b2 = bytes[i]
            i = i + 1
            local b3 = bytes[i]
            i = i + 1

            chr = bit.bor(
                bit.arshift(bit.band(byte, 0x07), 18),
                bit.arshift(bit.band(bytes[b1], 0x3f), 12),
                bit.arshift(bit.band(bytes[b2], 0x3f), 6),
                bit.arshift(bit.band(bytes[b3], 0x3f), 0)
            )
            if (chr >= 0x010000) then -- surrogate pair
                chr = chr - 0x010000
                error("not supported string!" .. tostring(chr))
                -- str = str .. str.char((chr >>> 10) + 0xD800, bit.band(chr, 0x3FF) + 0xDC00)
            else
                str = str .. string.char(chr)
            end
            break
        end

        pprint(str)
        error('invalid byte ' .. byte)
        break
    until true
  end

  return str
end

function boolean (bytes, it) 
    return uint8(bytes, it) == 1
end

function int8 (bytes, it) 
    return bit.arshift(bit.lshift(uint8(bytes, it), 24), 24)
end

function uint8 (bytes, it) 
    local int = bytes[it.offset]
    it.offset = it.offset + 1
    return int
end

function int16 (bytes, it) 
    return bit.arshift(bit.lshift(uint16(bytes, it), 16), 16)
end

function uint16 (bytes, it) 
    local n1 = bytes[it.offset]
    it.offset = it.offset + 1

    local n2 = bytes[it.offset]
    it.offset = it.offset + 1

    return bit.bor(n1, bit.lshift(n2, 8))
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

    return bit.bor(n1, bit.arshift(n2, 8), bit.arshift(n3, 16), bit.arshift(n4, 24))
end

function uint32 (bytes, it) 
    -- TODO:
    -- return int32(bytes, it) >>> 0
    return int32(bytes, it)
end

function float32(bytes, it)
    local b1 = bytes[it.offset]
    local b2 = bytes[it.offset + 1]
    local b3 = bytes[it.offset + 2]
    local b4 = bytes[it.offset + 3]
    local sign = b1 > 0x7F
    local expo = (b1 % 0x80) * 0x2 + math.floor(b2 / 0x80)
    local mant = ((b2 % 0x80) * 0x100 + b3) * 0x100 + b4
    if sign then
        sign = -1
    else
        sign = 1
    end
    local n
    if mant == 0 and expo == 0 then
        n = sign * 0.0
    elseif expo == 0xFF then
        if mant == 0 then
            n = sign * huge
        else
            n = 0.0/0.0
        end
    else
        n = sign * ldexp(1.0 + mant / 0x800000, expo - 0x7F)
    end
    it.offset = it.offset + 4
    return n
end

function float64(bytes, it)
    local b1 = bytes[it.offset + 7]
    local b2 = bytes[it.offset + 6]
    local b3 = bytes[it.offset + 5]
    local b4 = bytes[it.offset + 4]
    local b5 = bytes[it.offset + 3]
    local b6 = bytes[it.offset + 2]
    local b7 = bytes[it.offset + 1]
    local b8 = bytes[it.offset]

    -- TODO: detect big/little endian?

    -- local b1 = bytes[it.offset]
    -- local b2 = bytes[it.offset + 1]
    -- local b3 = bytes[it.offset + 2]
    -- local b4 = bytes[it.offset + 3]
    -- local b5 = bytes[it.offset + 4]
    -- local b6 = bytes[it.offset + 5]
    -- local b7 = bytes[it.offset + 6]
    -- local b8 = bytes[it.offset + 7]

    local sign = b1 > 0x7F
    local expo = (b1 % 0x80) * 0x10 + math.floor(b2 / 0x10)
    local mant = ((((((b2 % 0x10) * 0x100 + b3) * 0x100 + b4) * 0x100 + b5) * 0x100 + b6) * 0x100 + b7) * 0x100 + b8
    if sign then
        sign = -1
    else
        sign = 1
    end
    local n
    if mant == 0 and expo == 0 then
        n = sign * 0.0
    elseif expo == 0x7FF then
        if mant == 0 then
            n = sign * huge
        else
            n = 0.0/0.0
        end
    else
        n = sign * ldexp(1.0 + mant / 4503599627370496.0, expo - 0x3FF)
    end
    it.offset = it.offset + 8
    return n
end

function _string (bytes, it) 
  local prefix = bytes[it.offset]
  it.offset = it.offset + 1

  local length = bit.band(prefix, 0x1f)
  local value = utf8_read(bytes, it.offset, length)
  it.offset = it.offset + length

  return value
end

function string_check (bytes, it) 
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
    return float32(bytes, it)

  elseif (prefix == 203) then
    -- float 64
    return float64(bytes, it)

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

function number_check (bytes, it) 
  local prefix = bytes[it.offset]
  return (prefix < 128 or (prefix >= 202 and prefix <= 211))
end

function array_check (bytes, it) 
  return bytes[it.offset] < 160
end

function nil_check (bytes, it) 
  return bytes[it.offset] == spec.NIL
end

function index_change_check (bytes, it) 
  return bytes[it.offset] == spec.INDEX_CHANGE
end

local decode = {
    boolean = boolean,
    int8 = int8,
    uint8 = uint8,
    int16 = int16,
    uint1 = uint1,
    int32 = int32,
    uint32 = uint32,
    float32 = float32,
    float64 = float64,
    number = number,
    string = _string,
    string_check = string_check,
    number_check = number_check,
    array_check = array_check,
    nil_check = nil_check,
    index_change_check = index_change_check,
}
-- END DECODE --


-- START UTIL FUNCTIONS --
local pprint = pprint or function(node)
    -- to make output beautiful
    local function tab(amt)
        local str = ""
        for i=1,amt do
            str = str .. "\t"
        end
        return str
    end

    local cache, stack, output = {},{},{}
    local depth = 1
    local output_str = "{\n"

    while true do
        local size = 0
        for k,v in pairs(node) do
            size = size + 1
        end

        local cur_index = 1
        for k,v in pairs(node) do
            if (cache[node] == nil) or (cur_index >= cache[node]) then

                if (string.find(output_str,"}",output_str:len())) then
                    output_str = output_str .. ",\n"
                elseif not (string.find(output_str,"\n",output_str:len())) then
                    output_str = output_str .. "\n"
                end

                -- This is necessary for working with HUGE tables otherwise we run out of memory using concat on huge strings
                table.insert(output,output_str)
                output_str = ""

                local key
                if (type(k) == "number" or type(k) == "boolean") then
                    key = "["..tostring(k).."]"
                else
                    key = "['"..tostring(k).."']"
                end

                if (type(v) == "number" or type(v) == "boolean") then
                    output_str = output_str .. tab(depth) .. key .. " = "..tostring(v)
                elseif (type(v) == "table") then
                    output_str = output_str .. tab(depth) .. key .. " = {\n"
                    table.insert(stack,node)
                    table.insert(stack,v)
                    cache[node] = cur_index+1
                    break
                else
                    output_str = output_str .. tab(depth) .. key .. " = '"..tostring(v).."'"
                end

                if (cur_index == size) then
                    output_str = output_str .. "\n" .. tab(depth-1) .. "}"
                else
                    output_str = output_str .. ","
                end
            else
                -- close the table
                if (cur_index == size) then
                    output_str = output_str .. "\n" .. tab(depth-1) .. "}"
                end
            end

            cur_index = cur_index + 1
        end

        if (size == 0) then
            output_str = output_str .. "\n" .. tab(depth-1) .. "}"
        end

        if (#stack > 0) then
            node = stack[#stack]
            stack[#stack] = nil
            depth = cache[node] == nil and depth + 1 or depth - 1
        else
            break
        end
    end

    -- This is necessary for working with HUGE tables otherwise we run out of memory using concat on huge strings
    table.insert(output,output_str)
    output_str = table.concat(output)

    print(output_str)
end

function decode_primitive_type (ftype, bytes, it) 
    local func = decode[ftype]
    return func and func(bytes, it) or nil
end

function table.clone(orig)
    local orig_type = type(orig)
    local copy
    if orig_type == 'table' then
        copy = {}
        for orig_key, orig_value in pairs(orig) do
            copy[orig_key] = orig_value
        end
    else -- number, string, boolean, etc
        copy = orig
    end
    return copy
end

function table.keys(orig)
    local keyset = {}
    for k,v in pairs(orig) do
      keyset[#keyset + 1] = k
    end
    return keyset
end
-- END UTIL FUNCTIONS --

-- START SCHEMA CLASS --
local Schema = {}

function Schema:new(obj)
    obj = obj or {}
    setmetatable(obj, self)
    self.__index = self
    return obj
end

function Schema:decode(bytes, it)
    local changes = {}

    if it == nil then
        it = { offset = 1 }
    end

    local schema = self._schema
    local fields_by_index = self._order

    local total_bytes = #bytes
    while it.offset <= total_bytes do
        local index = bytes[it.offset]
        it.offset = it.offset + 1

        -- reached end of strucutre. skip.
        if index == spec.END_OF_STRUCTURE then 
            break 
        end

        local field = fields_by_index[index + 1]
        local ftype = schema[field]
        local value = nil

        local change = nil
        local has_change = false

        -- FIXME: this may cause issues if the `index` provided actually matches a field.
        -- WORKAROUND for LUA on emscripten environment 
        -- (reached end of buffer)
        if not field then
            it.offset = it.offset - 1
            break
        end

        if type(ftype) == "table" and ftype['new'] ~= nil then
            if decode.nil_check(bytes, it) then
                it.offset = it.offset + 1
                value = nil
            else
                -- decode child Schema instance
                value = self[field] or ftype:new()
                value:decode(bytes, it)
                has_change = true
            end

        elseif type(ftype) == "table" and ftype['map'] == nil then
            -- decode array
            local typeref = ftype[1]
            change = {}

            local value_ref = self[field] or {}
            value = table.clone(value_ref) -- create new reference for array

            local new_length = decode.number(bytes, it)
            local num_changes = decode.number(bytes, it)

            has_change = (num_changes > 0)

            -- FIXME: this may not be reliable. possibly need to encode this variable during
            -- serializagion
            local has_index_change = false

            -- ensure current array has the same length as encoded one
            if #value >= new_length then
                local new_values = {}
                for i, item in ipairs(value) do
                    if i > new_length then
                        -- call "on_removed" on exceeding items
                        if item["on_remove"] ~= nil then
                            item["on_remove"]()
                        end

                        -- call on_remove from ArraySchema
                        if value_ref["on_remove"] ~= nil then
                            value_ref["on_remove"](item, i)
                        end
                    else
                        table.insert(new_values, item)
                    end
                end

                value = new_values
            end

            local i = 0
            while i < num_changes do
                local new_index = decode.number(bytes, it)

                -- lua indexes start at 1
                if new_index ~= nil then 
                    new_index = new_index + 1 
                end
                -- 

                -- index change check
                local index_change_from
                if (decode.index_change_check(bytes, it)) then
                    decode.uint8(bytes, it)
                    index_change_from = decode.number(bytes, it) + 1
                    has_index_change = true
                end

                -- LUA: do/end block is necessary due to `break`
                -- workaround because lack of `continue` statement in LUA
                local break_outer_loop = false
                repeat
                    if typeref['new'] ~= nil then -- is instance of Schema
                        local item
                        local is_new = (has_index_change and index_change_from == nil and new_index ~= nil);

                        if has_index_change and index_change_from == nil and new_index ~= nil then
                            item = typeref:new()

                        elseif (index_change_from ~= nil) then
                            item = value_ref[index_change_from]

                        elseif (new_index ~= nil) then
                            item = value_ref[new_index]
                        end

                        if item == nil then
                            item = typeref:new()
                            is_new = true
                        end

                        if decode.nil_check(bytes, it) then
                            it.offset = it.offset + 1

                            -- call on_remove from ArraySchema
                            if value_ref['on_remove'] ~= nil then
                                value_ref['on_remove'](item, new_index)
                            end

                            break -- continue
                        end

                        item:decode(bytes, it)

                        -- add on_add from ArraySchema
                        if is_new and value_ref['on_add'] then
                            value_ref['on_add'](item, new_index)
                        end

                        value[new_index] = item

                    else 
                        value[new_index] = decode_primitive_type(typeref, bytes, it)
                    end

                    table.insert(change, value[new_index])

                    break -- continue
                until true

                -- workaround because lack of `continue` statement in LUA
                if break_outer_loop then break end

                i = i + 1
            end

        elseif type(ftype) == "table" and ftype['map'] ~= nil then
            -- decode map
            ftype = ftype['map']

            local maporder_key = "_" .. field .. "_maporder"
            local value_ref = self[field] or {}
            value = table.clone(value_ref)

            local length = decode.number(bytes, it)
            has_change = (length > 0)

            -- FIXME: this may not be reliable. possibly need to encode this variable during
            -- serializagion
            local has_index_change = false

            local i = 0
            while i < length do
                local break_outer_loop = false
                repeat
                    -- `encodeAll` may indicate a higher number of indexes it actually encodes
                    if bytes[it.offset] == nil or bytes[it.offset] == spec.END_OF_STRUCTURE then
                        break_outer_loop = true
                        break -- continue
                    end

                    -- index change check
                    local previous_key
                    if decode.index_change_check(bytes, it) then
                        decode.uint8(bytes, it)
                        previous_key = self[maporder_key][decode.number(bytes, it)+1]
                        has_index_change = true
                    end

                    local has_map_index = decode.number_check(bytes, it)

                    local new_key
                    if has_map_index then 
                if has_map_index then 
                    if has_map_index then 
                        local map_index = decode.number(bytes, it) + 1
                        new_key = self[maporder_key][map_index] 
                    else 
                else 
                    else 
                        new_key = decode.string(bytes, it)
                    end

                    local item
                    local is_new = (has_index_change and previous_key == nil and has_map_index)

                    if has_index_change and previous_key == nil and has_map_index then
                        item = ftype:new()

                    elseif previous_key ~= nil then
                        item = value_ref[previous_key]

                    else 
                else 
                    else 
                        item = value_ref[new_key]
                    end

                    if item == nil and ftype ~= "string" then
                        item = ftype:new()
                        is_new = true
                    end

                    if decode.nil_check(bytes, it) then
                        it.offset = it.offset + 1

                        if item ~= nil and item['on_remove'] ~= nil then
                            item['on_remove']()
                        end

                        if value_ref['on_remove'] ~= nil then
                            value_ref['on_remove'](item, new_key)
                        end

                        value[new_key] = nil
                        break -- continue

                    elseif type == "string"  then
                        value[new_key] = decode_primitive_type(type, bytes, it)

                    else 
                else 
                    else 
                        item:decode(bytes, it)
                        value[new_key] = item

                        if is_new and value_ref['on_add'] ~= nil then
                            value_ref['on_add'](item, new_key)

                        elseif value_ref['on_change'] ~= nil then
                            value_ref['on_change'](item, new_key)
                        end
                    end

                    if is_new then
                        -- LUA-specific keep track of keys ordering (lua tables doesn't keep then)
                        if self[maporder_key] == nil then
                            self[maporder_key] = {}
                        end
                        table.insert(self[maporder_key], new_key)
                        --
                    end

                    break -- continue
                until true

                if break_outer_loop then break end

                i = i + 1
            end

        else
            -- decode primivite type
            value = decode_primitive_type(ftype, bytes, it)
            has_change = true
        end

        if self["on_change"] and has_change then
            table.insert(changes, {
                field = field,
                value = change or value,
                previous_value = self[field]
            })
        end

        self[field] = value
    end

    if self["on_change"] ~= nil and table.getn(changes) then
        self["on_change"](changes)
    end

    return self
end
-- END SCHEMA CLASS --

local define = function(fields)
    local DerivedSchema = Schema:new()

    DerivedSchema._schema = {}
    DerivedSchema._order = fields and fields['_order'] or {}

    for i, field in pairs(DerivedSchema._order) do
        DerivedSchema._schema[field] = fields[field]
    end

    return DerivedSchema
end

-- START REFLECTION --
local ReflectionField = define({
    ["name"] = "string",
    ["type"] = "string",
    ["referenced_type"] = "number",
    ["_order"] = {"name", "type", "referenced_type"}
})

local ReflectionType = define({
    ["id"] = "number",
    ["fields"] = { ReflectionField },
    ["_order"] = {"id", "fields"}
})

local Reflection = define({
    ["types"] = { ReflectionType },
    ["_order"] = {"types"}
})

local reflection_decode = function (bytes, it)
    local reflection = Reflection:new()
    reflection:decode(bytes, it)

    local add_field_to_schema = function(schema_class, field_name, field_type)
        schema_class._schema[field_name] = field_type
        table.insert(schema_class._order, field_name)
    end

    local schema_types = {}

    for i, reflection_type in ipairs(reflection.types) do
        schema_types[reflection_type.id + 1] = define({})
    end

    for i = 1, #reflection.types do
        local reflection_type = reflection.types[i]

        for j = 1, #reflection_type.fields do
            local schema_type = schema_types[reflection_type.id + 1]
            local field = reflection_type.fields[j]

            if field.referenced_type ~= nil then
                local referenced_type = schema_types[field.referenced_type + 1]

                if field.type == "array" then
                    add_field_to_schema(schema_type, field.name, { referenced_type })

                elseif field.type == "map" then
                    add_field_to_schema(schema_type, field.name, { map = referenced_type })

                elseif field.type == "ref" then
                    add_field_to_schema(schema_type, field.name, referenced_type)
                end

            else
                add_field_to_schema(schema_type, field.name, field.type)
            end
        end
    end

    local root_type = schema_types[1]
    local root_instance = root_type:new()

    for i = 1, #root_type._order do
        local field_name = root_type._order[i]
        local field_type = root_type._schema[field_name]

        if type(field_type) ~= "string" then
            -- local is_schema = field_type['new'] ~= nil
            -- local is_map = field_type['map'] ~= nil
            -- local is_array = type(field_type) == "table" and (not is_schema) and (not is_map)

            if field_type['new'] ~= nil then
                root_instance[field_name] = field_type:new()

            elseif type(field_type) == "table" then
                root_instance[field_name] = {}
            end
        end
    end

    return root_instance
end
-- END REFLECTION --

return {
    define = define,
    reflection_decode = reflection_decode,
    string = decode.string,
    pprint = pprint
}