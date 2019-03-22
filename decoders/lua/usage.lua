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

local reflection_bytes = {0, 2, 2, 0, 1, 3, 3, 0, 0, 164, 110, 97, 109, 101, 1, 166, 115, 116, 114, 105, 110, 103, 193, 1, 0, 161, 120, 1, 166, 110, 117, 109, 98, 101, 114, 193, 2, 0, 161, 121, 1, 166, 110, 117, 109, 98, 101, 114, 193, 0, 1, 193, 1, 1, 5, 5, 0, 0, 171, 102, 105, 101, 108, 100, 83, 116, 114, 105, 110, 103, 1, 166, 115, 116, 114, 105, 110, 103, 193, 1, 0, 171, 102, 105, 101, 108, 100, 78, 117, 109, 98, 101, 114, 1, 166, 110, 117, 109, 98, 101, 114, 193, 2, 0, 166, 112, 108, 97, 121, 101, 114, 2, 1, 1, 163, 114, 101, 102, 193, 3, 0, 174, 97, 114, 114, 97, 121, 79, 102, 80, 108, 97, 121, 101, 114, 115, 2, 1, 1, 165, 97, 114, 114, 97, 121, 193, 4, 0, 172, 109, 97, 112, 79, 102, 80, 108, 97, 121, 101, 114, 115, 2, 1, 1, 163, 109, 97, 112, 193, 0, 0, 193}
local reflected = Schema.reflection_decode(reflection_bytes)

-- -- Array with three values
local encoded_state = {3, 2, 2, 0, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 1, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193}
local encoded_next_state = { 3, 2, 2, 2, 192, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193}

-- -- Map of two
-- local encoded_state = {4, 2, 163, 111, 110, 101, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 163, 116, 119, 111, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193}
-- local encoded_next_state = {4, 1, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193}

local state = State:new()
state:decode(encoded_state)
Schema.pprint(state)

state:decode(encoded_next_state)
Schema.pprint(state)
