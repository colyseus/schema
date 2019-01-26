local Schema = require('schema')

local Player = Schema({
    ["name"] = "string",
    ["x"] = "number",
    ["y"] = "number",

    ["on_change"] = function(changes)
    end,
    ["on_remove"] = function()
    end,

    -- field order
    ["_order"] = {"name", "x", "y"}
})

local State = Schema({
    ["fieldString"] = "string",
    ["fieldNumber"] = "number",
    ["player"] = Player,
    ["arrayOfPlayers"] = { Player },
    ["mapOfPlayers"] = { map = Player },

    -- field order
    ["_order"] = {"fieldString", "fieldNumber", "player", "arrayOfPlayers", "mapOfPlayers"}
})

-- local encoded_state = { 1, 50 }
local encoded_state = {0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100}

local state = State:new()
state:decode(encoded_state)

print("fieldString: " .. tostring(state.fieldString))
print("fieldNumber: " .. tostring(state.fieldNumber))
