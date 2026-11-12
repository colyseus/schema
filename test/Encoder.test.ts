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

    it("returns the bytes a caller wrote ahead of the starting offset", () => {
        // Colyseus stamps its protocol byte at 0 and encodes from 1, in a buffer that overflows here
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        for (let i = 0; i < 50; i++) { state.mapOfPlayers.set("player" + i, new Player().assign({ name: "Player " + i })); }
        const encoder = new Encoder(state);

        encoder.sharedBuffer[0] = 213;
        const full = encoder.encodeAll({ offset: 1 });
        assert.strictEqual(full[0], 213);

        state.mapOfPlayers.get("player1").x = 10;
        encoder.sharedBuffer[0] = 214;
        const it = { offset: 1 };
        const patch = encoder.encode(it);
        assert.strictEqual(patch[0], 214);
        assert.strictEqual(patch.length, it.offset);

        const decoded = createInstanceFromReflection(state);
        decoded.decode(full.subarray(1));
        decoded.decode(patch.subarray(1));
        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
    });

});
