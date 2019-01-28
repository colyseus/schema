--
-- @colyseus/schema decoder for LUA
-- Do not modify this file unless you know exactly what you're doing.
--
-- This file is part of Colyseus: https://github.com/colyseus/colyseus
--
local pprint = require('pprint')
local bit = bit or require('bit')
local decode = require('decode')
local spec = require('spec')

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

local Sync = {}

function Sync:new()
    local obj = {}
    return setmetatable(obj, { __index = self })
end

function Sync:decode(bytes, it)
    local changes = {}

    if it == nil then
        it = { offset = 1 }
    end

    local schema = self._schema
    local indexes = self._indexes
    local fields_by_index = self._order

    local total_bytes = #bytes
    while it.offset <= total_bytes do
        local index = bytes[it.offset]
        it.offset = it.offset + 1

        -- reached end of strucutre. skip.
        if index == spec.END_OF_STRUCTURE then break end

        local field = fields_by_index[index + 1]
        -- print("field: " .. tostring(field))

        local ftype = schema[field]
        local value = nil

        local change = nil
        local has_change = false

        if type(ftype) == "table" and ftype['new'] ~= nil then
            -- decode child Schema instance
            value = self[field] or ftype:new()
            value:decode(bytes, it)
            has_change = true

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
            if #value+1 > new_length then
                print("NEED SPLICE!")

                local new_values = {}
                for i, item in ipairs(value) do
                    if i > new_length then
                        -- call "on_removed" on exceeding items
                        if item["on_remove"] ~= nil then
                            item["on_remove"]()
                        end
                    else
                        table.insert(new_values, item)
                    end
                end

                value = new_values
                print("SPLICED!")
                pprint(value)
            end

            local i = 1
            ::continue_array::
            while i < num_changes do
                local new_index = decode.number(bytes, it)

                -- lua indexes start at 1
                if new_index ~= nil then new_index = new_index + 1 end

                if (decode.nil_check(bytes, it)) then
                    print("NIL!")
                    -- const item = this[`_${field}`][new_index]
                    -- TODO: trigger `onRemove` on Sync object being removed.
                    it.offset = it.offset + 1
                    i = i + 1
                    goto continue_array
                end

                -- index change check
                local index_change_from
                if (decode.index_change_check(bytes, it)) then
                    decode.uint8(bytes, it)
                    index_change_from = decode.number(bytes, it) + 1
                    has_index_change = true
                end

                if typeref['new'] ~= nil then
                    local item

                    if has_index_change and index_change_from == nil and new_index ~= nil then
                        item = typeref:new()

                    elseif (index_change_from ~= nil) then
                        item = value_ref[index_change_from]

                    elseif (new_index ~= nil) then
                        item = value_ref[new_index]
                    end

                    if item == nil then
                        item = typeref:new()
                    end

                    item:decode(bytes, it)
                    value[new_index] = item

                else 
                    value[new_index] = decode_primitive_type(typeref, bytes, it)
                end

                table.insert(change, value[new_index])
                i = i + 1
            end

        elseif type(ftype) == "table" and ftype['map'] ~= nil then
            -- decode map
            ftype = ftype['map']

            local value_ref = self[field] or {}
            value = table.clone(value_ref)

            local length = decode.number(bytes, it)
            has_change = (length > 0)

            -- FIXME: this may not be reliable. possibly need to encode this variable during
            -- serializagion
            local has_index_change = false

            local i = 0
            repeat
                -- index change check
                local previous_key
                if decode.index_change_check(bytes, it) then
                    decode.uint8(bytes, it)
                    previous_key = table.keys(value_ref)[decode.number(bytes, it)+1]
                    has_index_change = true
                end

                local has_map_index = decode.number_check(bytes, it)
                
                local new_key
                if has_map_index then 
                    new_key = table.keys(value_ref)[decode.number(bytes, it)+1] 
                else 
                    new_key = decode.string(bytes, it)
                end

                local item

                if has_index_change and previous_key == nil and has_map_index then
                    item = ftype:new()

                elseif previous_key ~= nil then
                    item = value_ref[previous_key]

                else 
                    item = value_ref[new_key]
                end

                if item == nil then
                    item = ftype:new()
                end

                if decode.nil_check(bytes, it) then
                    it.offset = it.offset + 1

                    if item['on_remove'] ~= nil then
                        item['on_remove']()
                    end

                    value[new_key] = nil
                    goto continue_map

                else 
                    item:decode(bytes, it)
                    value[new_key] = item
                end

                ::continue_map::
                i = i + 1
            until i >= length

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

        if field ~= nil then
            self[field] = value
        end
    end

    if self["on_change"] ~= nil and table.getn(changes) then
        self["on_change"](changes)
    end

    return self
end

return function(fields)
    local DerivedSync = setmetatable({}, { __index = Sync })

    function DerivedSync:new()
        local obj = {}
        return setmetatable(obj, { __index = Sync.new(self) })
    end

    DerivedSync._schema = {}
    DerivedSync._indexes = {}
    DerivedSync._order = fields['_order']

    for i, field in pairs(DerivedSync._order) do
        DerivedSync._indexes[field] = i
        DerivedSync._schema[field] = fields[field]
    end

    return DerivedSync
end