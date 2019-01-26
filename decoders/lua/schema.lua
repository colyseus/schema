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

function decode_primitive_type (type, bytes, it) 
    local func = decode[type]
    return func and func(bytes, it) or nil
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
    while it.offset < total_bytes do
        local index = bytes[it.offset];
        local field = fields_by_index[index + 1];

        it.offset = it.offset + 1

        -- print("index: " .. tostring(index))
        print("field: " .. tostring(field))

        -- reached end of strucutre. skip.
        if index == END_OF_STRUCTURE then break end

        local type = schema[field]
        local value = nil

        local change = nil
        local has_change = false

        value = decode_primitive_type(type, bytes, it)
        print("VALUE:" .. tostring(value))

        self[field] = value
        -- has_change = true;
    end

    if self["on_change"] ~= nil and table.getn(changes) then
        self["on_change"](changes)
    end
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