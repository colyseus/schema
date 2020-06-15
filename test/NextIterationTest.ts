import * as util from "util";
import * as assert from "assert";

import { Schema, type, MapSchema, ArraySchema, filter, filterChildren } from "../src";
import { logChangeTree } from "./helpers/test_helpers";

describe("Next Iteration", () => {

    it("add and modify an array item", () => {
        class State extends Schema {
            @type(["string"])
            arr: string[];
        }

        const state = new State({ arr: [] });
        console.log("ARR =>", state.arr);
        state.arr.push("one");
        state.arr.push("two");
        state.arr.push("three");

        console.log("\n\nLETS ENCODE:");
        let encoded = state.encode();

        console.log("\n\nLETS DECODE:");

        const decoded = new State();
        decoded.decode(encoded);
        assert.deepEqual(decoded.arr['$items'], ['one', 'two', 'three']);

        console.log("\n\nDISCARDING CHANGES...");

        // discard previous changes
        state.discardAllChanges();

        state.arr[1] = "t";

        console.log("\n\nLETS ENCODE:");
        encoded = state.encode();

        console.log("\n\nLETS DECODE:", encoded.length, encoded);
        decoded.decode(encoded);

        assert.deepEqual(decoded.arr['$items'], ['one', 't', 'three']);
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
        decoded.decode(encoded);

        assert.deepEqual(decoded.map.get("one"), 1);
        assert.deepEqual(decoded.map.get("two"), 2);
        assert.deepEqual(decoded.map.get("three"), 3);

        state.map.set("two", 22);

        encoded = state.encode();
        decoded.decode(encoded);

        assert.deepEqual(decoded.map.get("two"), 22);
    });

    it("MapSchema should be backwards-compatible with @colyseus/schema 0.5", () => {
        class State extends Schema {
            @type({ map: "number" })
            map = new MapSchema<number>();
        }

        const state = new State();
        state.map["one"] = 1;
        state.map["two"] = 2;

        const decoded = new State();
        decoded.decode(state.encode());

        console.log("DECODED =>", util.inspect(decoded.toJSON(), true, Infinity));

        console.log("\n\nLETS ASSERT!\n\n");
        assert.equal(2, decoded.map.size);
        assert.equal(1, decoded.map.get("one"));
        assert.equal(2, decoded.map.get("two"));

        console.log("MAP =>", decoded.map);
        assert.equal(1, decoded.map["one"]);
        assert.equal(2, decoded.map["two"]);

        delete state.map['one'];

        const encoded = state.encode();

        console.log("\n\nLETS DECODE!!", encoded.length, encoded);
        decoded.decode(encoded);

        console.log("DECODED =>", util.inspect(decoded.toJSON(), true, Infinity));

        assert.equal(1, decoded.map.size);
        assert.equal(undefined, decoded.map["one"]);
        assert.equal(2, decoded.map["two"]);
    });

    it("add and modify a filtered primitive map item", () => {
        class State extends Schema {
            @filterChildren(function(client, key, value, root) {
                return client.sessionId === key;
            })
            @type({ map: "number" })
            map = new Map<string, number>();
        }

        const state = new State();
        state.map.set("one", 1);
        state.map.set("two", 2);
        state.map.set("three", 3);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };
        const client3 = { sessionId: "three" };

        const decoded1 = new State();
        const decoded2 = new State();
        const decoded3 = new State();

        let encoded = state.encode(undefined, undefined, undefined, true);

        console.log("ENCODED (FULL)", encoded.length, encoded);

        let encoded1 = state.applyFilters(encoded, client1);
        console.log("ENCODED (CLIENT 1)", encoded1.length, encoded1);

        let encoded2 = state.applyFilters(encoded, client2);
        console.log("ENCODED (CLIENT 2)", encoded2.length, encoded2);

        let encoded3 = state.applyFilters(encoded, client3);
        console.log("ENCODED (CLIENT 3)", encoded3.length, encoded3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 1);
        assert.equal(decoded1.map.get("one"), 1);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 1);
        assert.equal(decoded2.map.get("two"), 2);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 1);
        assert.equal(decoded3.map.get("three"), 3);

        // discard previous changes
        state.discardAllChanges();

        // mutate "two" key.
        state.map.set("two", 22);
        encoded = state.encode(undefined, undefined, undefined, true);

        console.log("\n\n>> PREVIOUS CHANGES HAVE BEEN DISCARDED\n\n");

        encoded1 = state.applyFilters(encoded, client1);
        console.log("ENCODED (CLIENT 1)", encoded1.length, encoded1);

        encoded2 = state.applyFilters(encoded, client2);
        console.log("ENCODED (CLIENT 2)", encoded2.length, encoded2);

        encoded3 = state.applyFilters(encoded, client3);
        console.log("ENCODED (CLIENT 3)", encoded3.length, encoded3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 1);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 1);
        assert.deepEqual(decoded2.map.get("two"), 22);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 1);
    });

    it("add and modify a filtered Schema map item", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class State extends Schema {
            @filterChildren(function(client, key: string, value: Player, root: State) {
                return client.sessionId === key;
            })
            @type({ map: Player })
            map = new Map<string, Player>();
        }

        const state = new State();
        state.map.set("one", new Player().assign({ x: 1, y: 1 }));
        state.map.set("two", new Player().assign({ x: 2, y: 2 }));
        state.map.set("three", new Player().assign({ x: 3, y: 3 }));

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };
        const client3 = { sessionId: "three" };

        const decoded1 = new State();
        const decoded2 = new State();
        const decoded3 = new State();

        let encoded = state.encode(undefined, undefined, undefined, true);

        console.log("ENCODED (FULL)", encoded.length, encoded);

        let encoded1 = state.applyFilters(encoded, client1);
        console.log("ENCODED (CLIENT 1)", encoded1.length, encoded1);

        console.log("\n\nWILL APPLY FILTERS!\n\n");

        let encoded2 = state.applyFilters(encoded, client2);
        console.log("ENCODED (CLIENT 2)", encoded2.length, encoded2);

        let encoded3 = state.applyFilters(encoded, client3);
        console.log("ENCODED (CLIENT 3)", encoded3.length, encoded3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 1);
        assert.equal(decoded1.map.get("one").x, 1);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 1);
        assert.equal(decoded2.map.get("two").x, 2);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 1);
        assert.equal(decoded3.map.get("three").x, 3);

        console.log("DECODED 1 =>", util.inspect(decoded1.toJSON(), true, Infinity));
        console.log("DECODED 2 =>", util.inspect(decoded2.toJSON(), true, Infinity));
        console.log("DECODED 3 =>", util.inspect(decoded3.toJSON(), true, Infinity));

        // discard previous changes
        state.discardAllChanges();

        // mutate all items
        state.map.get("one").x = 11;
        state.map.get("two").x = 22;
        state.map.get("three").x = 33;

        encoded = state.encode(undefined, undefined, undefined, true);

        console.log("\n\n>> PREVIOUS CHANGES HAVE BEEN DISCARDED\n\n");

        encoded1 = state.applyFilters(encoded, client1);
        console.log("ENCODED (CLIENT 1)", encoded1.length, encoded1);

        encoded2 = state.applyFilters(encoded, client2);
        console.log("ENCODED (CLIENT 2)", encoded2.length, encoded2);

        encoded3 = state.applyFilters(encoded, client3);
        console.log("ENCODED (CLIENT 3)", encoded3.length, encoded3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 1);
        assert.deepEqual(decoded1.map.get("one").x, 11);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 1);
        assert.deepEqual(decoded2.map.get("two").x, 22);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 1);
        assert.deepEqual(decoded3.map.get("three").x, 33);

        console.log("DECODED 1 =>", util.inspect(decoded1.toJSON(), true, Infinity));
        console.log("DECODED 2 =>", util.inspect(decoded2.toJSON(), true, Infinity));
        console.log("DECODED 3 =>", util.inspect(decoded3.toJSON(), true, Infinity));
    });

    it("should encode string", () => {
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

    it("instances should share parent/root references", () => {
        class Skill extends Schema {
            @type("number") damage: number;
        }

        class Item extends Schema {
            @type("number") damage: number;
            @type({ map: Skill }) skills = new Map<string, Skill>();
        }

        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            @type(Item) item: Item;
        }

        class State extends Schema {
            @type("string") str: string;
            @type("number") num: number;
            @type({ map: Player }) players: Map<string, Player>;
            @type(Player) player: Player;
        };

        const state = new State();
        const player = new Player();
        player.item = new Item();
        state.player = player;

        const players = new Map<string, Player>();
        players.set("one", new Player());
        players.get("one").item = new Item();

        state.players = players;

        // Testing for "root".
        const $root = state['$changes'].root;
        assert.ok(player['$changes'].root === $root, "State and Player should have same 'root'.");
        assert.ok(player.item['$changes'].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one")['$changes'].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one").item['$changes'].root === $root, "Player and Item should have same 'root'.");

        // Testing for "parent".
        assert.ok(state['$changes'].parent === undefined, "State parent should be 'undefined'");
        assert.ok(state.player['$changes'].parent === state, "Player parent should be State");
        assert.ok(state.player.item['$changes'].parent === player, "Item parent should be Player");
        assert.ok(state.players.get("one")['$changes'].parent['$changes'].refId === state.players['$changes'].refId as any, "state.players['one'] parent should be state.players");
    });

    it("should encode filtered", () => {
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

        const decoded1 = new State();
        decoded1.decode(encoded1);

        console.log("\n\nAPPLY FILTERS FOR CLIENT 2");

        let encoded2 = state.applyFilters(encoded, client2);
        console.log("Encode filtered (2), length =>", encoded2.length, "=>", encoded2);

        const decoded2 = new State();
        decoded2.decode(encoded2);
        assert.equal("Hello", decoded2.str);

        // console.log("DECODED 1 =>", decoded1.toJSON());
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
        decoded1.decode(encoded1);

        encoded2 = state.applyFilters(encoded, client2);
        console.log("Encode filtered (2), length =>", encoded2.length, "=>", encoded2);
        decoded2.decode(encoded2);
        assert.equal(1, decoded2.num);

        assert.equal(2, decoded1.player.x);
        assert.equal(6, decoded1.player.item.damage);

        console.log("DECODED 1 =>", decoded1.toJSON());
        console.log("DECODED 2 =>", decoded2.toJSON());
    });

    it("encoding / decoding deep items", () => {
        class Item extends Schema {
            @type("string") name: string;
        }

        class Player extends Schema {
            @type({ map: Item }) items = new Map<string, Item>();
        }

        class State extends Schema {
            @type({ map: Player }) players = new Map<string, Player>();
        }

        const state = new State();

        const one = new Player();
        const i1 = new Item();
        i1.name = "player one item 1";
        one.items.set("i1", i1);
        state.players.set("one", one);

        const two = new Player();
        const i2 = new Item();
        i2.name = "player two item 2";
        two.items.set("i2", i2);
        state.players.set("two", two);

        console.log("CHANGE TREE =>", logChangeTree(state['$changes']))

        const patch = state.encode();
        console.log("ENCODED =>", patch.length, patch);

        const decoded = new State();
        console.log("\n>> WILL DECODE\n");
        decoded.decode(patch);

        console.log(util.inspect(decoded.toJSON(), true, Infinity));

        assert.equal(2, decoded.players.size);
        assert.equal(1, decoded.players.get("one").items.size);
        assert.equal("player one item 1", decoded.players.get("one").items.get("i1").name);
        assert.equal(1, decoded.players.get("two").items.size);
        assert.equal("player two item 2", decoded.players.get("two").items.get("i2").name);
    });

});
