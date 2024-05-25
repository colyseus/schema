import * as assert from "assert";

import { Schema, type, ArraySchema } from "../../src";
import { createInstanceFromReflection, getCallbacks } from "../Schema";

describe("StateCallbacks", () => {

    it("should trigger changes in order they've been originally made", () => {
        class State extends Schema {
            @type(['string']) boardTiles = new ArraySchema<string>();
            @type('int64') actionType: number;
        }

        const state = new State();

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        const $ = getCallbacks(decodedState).$;

        state.boardTiles.push('one');
        state.actionType = 1;

        const actionOrder: any[] = [];

        $(decodedState).boardTiles.onAdd((item, key) => actionOrder.push("boardTiles.onAdd"));
        $(decodedState).listen('actionType', (curr, prev) => actionOrder.push("actionType"));

        decodedState.decode(state.encode());

        assert.deepStrictEqual(actionOrder, ["boardTiles.onAdd", "actionType"]);
    });


});