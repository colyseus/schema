import * as assert from "assert";

import { State, Player } from "./Schema";
import { Reflection } from "../src/annotations";
import { MapSchema, ArraySchema } from "../src";

describe("Reflection", () => {

    it("should encode schema definitions", () => {
        const state = new State();
        const reflected = new Reflection();
        assert.equal(
            JSON.stringify(reflected.decode(Reflection.encode(state))),
            '{"types":[{"id":1,"fields":[{"name":"name","type":"string"},{"name":"x","type":"number"},{"name":"y","type":"number"}]},{"id":0,"fields":[{"name":"fieldString","type":"string"},{"name":"fieldNumber","type":"number"},{"name":"player","type":"ref","referencedType":1},{"name":"arrayOfPlayers","type":"array","referencedType":1},{"name":"mapOfPlayers","type":"map","referencedType":1}]}]}'
        );
    });

    it("should initialize ref types with empty structures", () => {
        const state = new State();
        const stateReflected: State = Reflection.decode(Reflection.encode(state))

        assert.equal(stateReflected.arrayOfPlayers.length, 0);
        assert.equal(Object.keys(stateReflected.mapOfPlayers).length, 0);
        assert.equal(JSON.stringify(stateReflected.player), "{}");
    });

    it("should decode schema and be able to use it", () => {
        const state = new State();
        const stateReflected = Reflection.decode(Reflection.encode(state))

        assert.deepEqual(state._indexes, stateReflected._indexes);

        state.fieldString = "Hello world!";
        state.fieldNumber = 10;
        state.player = new Player("directly referenced player", 1, 1);
        state.mapOfPlayers = new MapSchema({
            'one': new Player("player one", 2, 2),
            'two': new Player("player two", 3, 3)
        })
        state.arrayOfPlayers = new ArraySchema(new Player("in array", 4, 4));

        stateReflected.decode(state.encode());
        
        assert.equal(stateReflected.fieldString, "Hello world!");
        assert.equal(stateReflected.fieldNumber, 10);

        assert.equal(stateReflected.player.name, "directly referenced player");
        assert.equal(stateReflected.player.x, 1);
        assert.equal(stateReflected.player.y, 1);

        assert.equal(Object.keys(stateReflected.mapOfPlayers).length, 2);
        assert.equal(stateReflected.mapOfPlayers['one'].name, "player one");
        assert.equal(stateReflected.mapOfPlayers['one'].x, 2);
        assert.equal(stateReflected.mapOfPlayers['one'].y, 2);
        assert.equal(stateReflected.mapOfPlayers['two'].name, "player two");
        assert.equal(stateReflected.mapOfPlayers['two'].x, 3);
        assert.equal(stateReflected.mapOfPlayers['two'].y, 3);

        assert.equal(stateReflected.arrayOfPlayers.length, 1);
        assert.equal(stateReflected.arrayOfPlayers[0].name, "in array");
        assert.equal(stateReflected.arrayOfPlayers[0].x, 4);
        assert.equal(stateReflected.arrayOfPlayers[0].y, 4);
    });

});