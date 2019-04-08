import * as assert from "assert";
import * as sinon from "sinon";
import * as nanoid from "nanoid";
import { MapSchema, Reflection } from "../src";

import { State, Player } from "./Schema";

describe("Edge cases", () => {
    describe("MapSchema", () => {
        it("index with high number of items should be preserved", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();

            let i = 0;

            // add 20 players
            // for (let i = 0; i < 2; i++) { state.mapOfPlayers[nanoid(8)] = new Player("Player " + i, i * 2, i * 2); }

            state.encodeAll();

            const decodedState1 = new State();
            decodedState1.decode(state.encodeAll());
            state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

            const decodedState2 = new State();
            state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
            decodedState2.decode(state.encodeAll());

            const decodedState3 = new State();
            decodedState3.decode(state.encodeAll());
            state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

            // // add 20 players
            // for (let i = 0; i < 2; i++) { state.mapOfPlayers[nanoid(8)] = new Player("Player " + i, i * 2, i * 2); }

            const encoded = state.encode();
            decodedState1.decode(encoded);
            decodedState2.decode(encoded);
            decodedState3.decode(encoded);

            const decodedState4 = new State();
            state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
            decodedState4.decode(state.encodeAll());

            assert.equal(JSON.stringify(decodedState1), JSON.stringify(decodedState2));
            assert.equal(JSON.stringify(decodedState2), JSON.stringify(decodedState3));

            decodedState3.decode(state.encode());
            assert.equal(JSON.stringify(decodedState3), JSON.stringify(decodedState4));
        });
    })
});
