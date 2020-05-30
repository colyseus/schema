import * as util from "util";
import * as assert from "assert";

import { ChangeTree } from "../src/ChangeTree";
import { Schema, type, MapSchema, ArraySchema } from "../src";

describe("Next Iteration", () => {

    xit("add and modify an array item", () => {
        class State extends Schema {
            @type(["string"])
            arr: string[]
        }

        const encoded = new State({ arr: [] });
        encoded.arr.push("one");
        encoded.arr.push("two");
        encoded.arr.push("three");

        const decoded = new State();
        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.arr, ['one', 'two', 'three']);

        encoded.arr[1] = "twotwo";
        decoded.decode(encoded.encode());

        assert.deepEqual(decoded.arr, ['one', 'twotwo', 'three']);
    });

    xit("add and modify a map item", () => {
        class State extends Schema {
            @type({ map: "number" })
            map = new Map<string, number>();
        }

        const encoded = new State();
        encoded.map.set("one", 1);
        encoded.map.set("two", 2);
        encoded.map.set("three", 3);

        const decoded = new State();
        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.map.get("one"), 1);
        assert.deepEqual(decoded.map.get("two"), 2);
        assert.deepEqual(decoded.map.get("three"), 3);

        encoded.map.set("two", 22);

        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.map.get("two"), 22);
    });

    it("should encode string", () => {
        class State extends Schema {
            @type("string") str: string;
        }
        const state = new State();
        state.str = "Hello";
        console.log(state.encode());
    });

    xit("encoding / decoding deep items", () => {
        class Item extends Schema {
            @type("string") name: string;
        }

        class Player extends Schema {
            @type({ map: Item }) items = new Map<string, Item>();
        }

        class State extends Schema {
            @type({ map: Player }) players = new Map<string, Player>();
        }

        const encoded = new State();

        const one = new Player();
        const i1 = new Item();
        i1.name = "player one item 1";
        one.items.set("i1", i1);
        encoded.players.set("one", one);

        const two = new Player();
        const i2 = new Item();
        i2.name = "player two item 2";
        two.items.set("i2", i2);
        encoded.players.set("two", two);

        const patch = encoded.encode();
        console.log("ENCODED =>", patch);

        const decoded = new State();
        console.log("\n>> WILL DECODE\n");
        decoded.decode(patch);
        console.log(util.inspect(decoded.toJSON(), true, Infinity));
    });

});
