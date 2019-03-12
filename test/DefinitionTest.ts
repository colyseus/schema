import * as assert from "assert";

import { Schema, type, Reflection, MapSchema } from "../src";

describe("Definition", () => {

    it("private Schema fields shouldn't be part of enumerable keys", () => {
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
        assert.deepEqual(Object.keys(obj.players), ['one']);
        assert.deepEqual(Object.keys(obj.players['one']), ['x', 'y', 'somethingPrivate']);
    });

    it("should allow a Schema instance with no fields", () => {
        class IDontExist extends Schema {}

        const obj = new IDontExist();
        assert.deepEqual(Object.keys(obj), []);
    });

});