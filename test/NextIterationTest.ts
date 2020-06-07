import * as util from "util";
import * as assert from "assert";

import { ChangeTree } from "../src/changes/ChangeTree";
import { Schema, type, MapSchema, ArraySchema, filter } from "../src";

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

    it("add and modify a map item", () => {
        class State extends Schema {
            @type({ map: "number" })
            map = new Map<string, number>();
        }

        const state = new State();
        state.map.set("one", 1);
        state.map.set("two", 2);
        state.map.set("three", 3);

        const decoded = new State();

        let encoded = state.encode();
        console.log("ENCODED (FULL), bytes =>", encoded.length, encoded);

        // console.log("\n\nWILL DECODE:\n");
        // decoded.decode(encoded);

        // assert.deepEqual(decoded.map.get("one"), 1);
        // assert.deepEqual(decoded.map.get("two"), 2);
        // assert.deepEqual(decoded.map.get("three"), 3);

        state.map.set("two", 22);

        encoded = state.encode();
        console.log("ENCODED (PATCH), bytes =>", encoded.length, encoded);

        console.log("\n\nWILL DECODE:\n");
        decoded.decode(encoded);

        assert.deepEqual(decoded.map.get("two"), 22);
    });

    xit("should encode string", () => {
        class Item extends Schema {
            @type("number") damage: number;
        }

        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            @type(Item) item: Item;
        }

        class State extends Schema {
            @type("string") str: string;
            @type("number") num: number;
            @type(Player) player: Player;
        };

        const state = new State();
        state.str = "Hello";
        state.num = 10;

        const player = new Player();
        player.x = 10;
        player.y = 20;

        player.item = new Item();
        player.item.damage = 5;

        state.player = player;

        let encoded = state.encode();
        console.log("Full encode, length =>", encoded.length, "=>", encoded);

        const decoded = new State();
        decoded.decode(encoded);
        console.log("DECODED =>", decoded.toJSON());

        state.num = 1;
        state.player.x = 2;
        state.player.item.damage = 6;

        console.log("\n\nWILL ENCODE PATCH\n\n")
        encoded = state.encode();

        console.log("Patch encode, length:", encoded.length, "=>", encoded);
        console.log("\n\nWILL DECODE\n\n")

        decoded.decode(encoded);
        console.log("DECODED =>", decoded.toJSON());
    });

    xit("should encode filtered", () => {
        class Item extends Schema {
            @type("number") damage: number;
        }

        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            @type(Item) item: Item;
        }

        class State extends Schema {
            @filter(function(client) { return client.sessionId === "two"; })
            @type("string") str: string;

            @filter(function(client) { return client.sessionId === "two"; })
            @type("number") num: number;

            @filter(function(client) { return client.sessionId === "one"; })
            @type(Player) player: Player;
        };

        const client1: any = { sessionId: "one" };
        const client2: any = { sessionId: "two" };

        const state = new State();
        state.str = "Hello";
        state.num = 10;

        const player = new Player();
        player.x = 10;
        player.y = 20;

        player.item = new Item();
        player.item.damage = 5;

        state.player = player;

        let encoded = state.encode(undefined, undefined, undefined, true);
        console.log("Full encode, length =>", encoded.length, "=>", encoded);

        console.log("\n\nAPPLY FILTERS FOR CLIENT 1");

        let encoded1 = state.applyFilters(encoded, client1);
        console.log("Encode filtered (1), length =>", encoded1.length, "=>", encoded1);

        console.log("\n\nAPPLY FILTERS FOR CLIENT 2");

        let encoded2 = state.applyFilters(encoded, client2);
        console.log("Encode filtered (2), length =>", encoded2.length, "=>", encoded2);

        const decoded1 = new State();
        decoded1.decode(encoded1);

        const decoded2 = new State();
        decoded2.decode(encoded2);

        console.log("DECODED 1 =>", decoded1.toJSON());
        console.log("DECODED 2 =>", decoded2.toJSON());

        state.discardAllChanges();

        state.num = 1;
        state.player.x = 2;
        state.player.item.damage = 6;

        console.log("\n\nWILL ENCODE PATCH\n\n")
        encoded = state.encode(undefined, undefined, undefined, true);

        console.log("Patch encode, length:", encoded.length, "=>", encoded);
        console.log("\n\nWILL DECODE\n\n")

        encoded1 = state.applyFilters(encoded, client1);
        console.log("Encode filtered (1), length =>", encoded1.length, "=>", encoded1);

        encoded2 = state.applyFilters(encoded, client2);
        console.log("Encode filtered (2), length =>", encoded2.length, "=>", encoded2);

        decoded1.decode(encoded1);
        decoded2.decode(encoded2);

        console.log("DECODED 1 =>", decoded1.toJSON());
        console.log("DECODED 2 =>", decoded2.toJSON());

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
