local Schema = require('schema')

local Player = Schema.define({
    ["name"] = "string",
    ["x"] = "number",
    ["y"] = "number",

    ["on_change"] = function(changes)
    end,

    ["on_remove"] = function()
        print("REMOVE!")
        print(self.name .. " HAS BEEN REMOVED!")
    end,

    -- field order
    ["_order"] = {"name", "x", "y"}
})

local State = Schema.define({
    ["fieldString"] = "string",
    ["fieldNumber"] = "number",
    ["player"] = Player,
    ["arrayOfPlayers"] = { Player },
    ["mapOfPlayers"] = { map = Player },

    -- field order
    ["_order"] = {"fieldString", "fieldNumber", "player", "arrayOfPlayers", "mapOfPlayers"}
})

-- -- number
-- local encoded_state = {1, 50}

-- -- string
-- local encoded_state = {0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100}

-- -- empty Player
-- local encoded_state = {2, 193}

-- -- Player with properties
-- local encoded_state = {2, 0, 164, 74, 97, 107, 101, 1, 100, 2, 204, 200, 193}
-- local encoded_next_state = {}

-- -- Array with three values
local encoded_state = {3, 2, 2, 0, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 1, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193}
local encoded_next_state = { 3, 2, 2, 2, 192, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193}

-- -- Map of two
-- local encoded_state = {4, 2, 163, 111, 110, 101, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 163, 116, 119, 111, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193}
-- local encoded_next_state = {4, 1, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193}

local state = State:new()
state:decode(encoded_state)
pprint(state)

state:decode(encoded_next_state)
pprint(state)
