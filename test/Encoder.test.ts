import * as assert from "assert";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection } from "./Schema";
import { encode, utf8LengthFallback } from "../src/encoding/encode";
import { decode } from "../src/encoding/decode";

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

    describe("strings with lone surrogates", () => {
        // e.g. a string sliced mid-emoji
        const cases: Array<[string, string]> = [
            ["\uD83D", "\uFFFD"],
            ["\uDE00", "\uFFFD"],
            ["a\uD83Db", "a\uFFFDb"],
            ["x\uDE00y", "x\uFFFDy"],
            ["\uDE00\uD83D", "\uFFFD\uFFFD"],
            ["ok \uD83D\uDE00", "ok \uD83D\uDE00"],
        ];

        it("should write the same bytes as TextEncoder", () => {
            for (const [value] of cases) {
                const bytes: number[] = [];
                encode.utf8Write(bytes, value, { offset: 0 });
                assert.deepStrictEqual(bytes, Array.from(new TextEncoder().encode(value)), JSON.stringify(value));
            }
        });

        it("should count the same length in the browser fallback as Buffer.byteLength", () => {
            for (const [value] of cases) {
                assert.strictEqual(utf8LengthFallback(value), Buffer.byteLength(value), JSON.stringify(value));
            }
        });

        it("should not corrupt the values encoded after it", () => {
            for (const [value, expected] of cases) {
                const bytes: number[] = [];
                const it = { offset: 0 };
                encode.string(bytes, value, it);
                encode.string(bytes, "next", it);
                encode.number(bytes, 42, it);

                const readIt = { offset: 0 };
                assert.strictEqual(decode.string(bytes, readIt), expected, JSON.stringify(value));
                assert.strictEqual(decode.string(bytes, readIt), "next", JSON.stringify(value));
                assert.strictEqual(decode.number(bytes, readIt), 42, JSON.stringify(value));
                assert.strictEqual(readIt.offset, bytes.length, JSON.stringify(value));
            }
        });

        it("should decode the fields after a truncated name", () => {
            const state = new Player("Bob \uD83D", 42, 7);

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encodeAll());

            assert.strictEqual(decodedState.name, "Bob \uFFFD");
            assert.strictEqual(decodedState.x, 42);
            assert.strictEqual(decodedState.y, 7);
        });
    });

});
