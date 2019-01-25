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

local encoded_state = {0, 173, 105, 110, 105, 116, 105, 97, 108, 32, 118, 97, 108, 117, 101, 1, 205, 300, 1}

local state = State:new()
state:decode(encoded_state)

print(state.fieldString)
print(state.fieldNumber)
