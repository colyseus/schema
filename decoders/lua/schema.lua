--
-- @colyseus/schema decoder for LUA
-- Do not modify this file unless you know exactly what you're doing.
--
-- This file is part of Colyseus: https://github.com/colyseus/colyseus
--
local pprint = require('pprint')


local END_OF_STRUCTURE = 193
local NIL = 192
local INDEX_CHANGE = 212

local Sync = {}

function Sync:new()
    local obj = {}
    return setmetatable(obj, { __index = self })
end

function Sync:decode(bytes, it)
    -- TODO
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