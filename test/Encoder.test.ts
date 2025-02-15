import * as assert from "assert";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection } from "./Schema";

describe("Encoder", () => {
    const bufferSize = Encoder.BUFFER_SIZE;

    before(() => Encoder.BUFFER_SIZE = 16);
    after(() => Encoder.BUFFER_SIZE = bufferSize);

    it("should resize buffer", () => {
        const state = new State();

        state.mapOfPlayers = new MapSchema<Player>();
        for (let i=0;i<5000;i++) {
            state.mapOfPlayers.set("player" + i, new Player().assign({
                name: "Player " + i,
                x: 50 * i,
                y: 50 * i,
            }));
        }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());
    });

});
