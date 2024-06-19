import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema, getStateCallbacks, decodeSchemaOperation, Decoder } from "../../src";
import { createInstanceFromReflection, getCallbacks, getDecoder } from "../Schema";

describe("StateCallbacks", () => {

    it("should trigger changes in order they've been originally made", () => {
        class State extends Schema {
            @type(['string']) boardTiles = new ArraySchema<string>();
            @type('int64') actionType: number;
        }

        const state = new State();

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        const $ = getCallbacks(decodedState);

        state.boardTiles.push('one');
        state.actionType = 1;

        const actionOrder: any[] = [];

        $.boardTiles.onAdd((item, key) => actionOrder.push("boardTiles.onAdd"));
        $.listen('actionType', (curr, prev) => actionOrder.push("actionType"));

        decodedState.decode(state.encode());

        assert.deepStrictEqual(actionOrder, ["boardTiles.onAdd", "actionType"]);
    });

    it("should bind changes into another object", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        state.players.set("one", new Player().assign({ x: 10, y: 10 }));

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        const $ = getCallbacks(decodedState);

    });


});