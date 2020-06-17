import * as assert from "assert";

import { Schema, type, MapSchema } from "../src";
import { defineTypes } from "../src/annotations";

describe("Definition", () => {

    it("private Schema fields should be part of enumerable keys", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            somethingPrivate: number = 10;
        }
        class MySchema extends Schema {
            @type("string")
            str: string;

            @type({map: Player})
            players = new MapSchema<Player>();

            notSynched: boolean = true;
        }

        const obj = new MySchema();
        obj.players['one'] = new Player();

        assert.deepEqual(Object.keys(obj), ['str', 'players', 'notSynched']);
        assert.deepEqual(Array.from(obj.players.keys()), ['one']);
        assert.deepEqual(Object.keys(obj.players['one']), ['x', 'y', 'somethingPrivate']);
    });

    it("should allow a Schema instance with no fields", () => {
        class IDontExist extends Schema {}

        const obj = new IDontExist();
        assert.deepEqual(Object.keys(obj), []);
    });

    describe("defineTypes", () => {
        it("should be equivalent", () => {
            class MyExistingStructure extends Schema {}
            defineTypes(MyExistingStructure, { name: "string" });

            const state = new MyExistingStructure();
            (state as any).name = "hello world!";

            const decodedState = new MyExistingStructure();
            decodedState.decode(state.encode());
            assert.equal((decodedState as any).name, "hello world!");
        });
    });
});