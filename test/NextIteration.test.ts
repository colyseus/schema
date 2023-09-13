import * as assert from "assert";

import { Schema, type, MapSchema, ArraySchema, filter, filterChildren } from "../src";

describe("Next Iteration", () => {

    it("add and modify an primary array item", () => {
        class State extends Schema {
            @type(["string"])
            arr: ArraySchema<string>;
        }

        const state = new State({ arr: [] });
        state.arr.push("one");
        state.arr.push("two");
        state.arr.push("three");

        let encoded = state.encode();

        const decoded = new State();
        decoded.decode(encoded);
        assert.deepEqual(decoded.arr.toArray(), ['one', 'two', 'three']);

        state.arr[1] = "t";

        encoded = state.encode();

        decoded.decode(encoded);

        assert.deepEqual(decoded.arr.toArray(), ['one', 't', 'three']);
    });

    it("add and modify an Schema array item", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }

        class State extends Schema {
            @type([Player])
            players: Player[];
        }

        const state = new State().assign({ players: [] });

        const p1 = new Player();
        p1.x = 1;
        p1.y = 1;
        state.players.push(p1);

        const p2 = new Player();
        p2.x = 2;
        p2.y = 2;
        state.players.push(p2);

        const p3 = new Player();
        p3.x = 3;
        p3.y = 3;
        state.players.push(p3);

        let encoded = state.encode();

        const decoded = new State();
        decoded.decode(encoded);

        assert.strictEqual(JSON.stringify(decoded.players.map(p => p.x)), "[1,2,3]");

        state.players[0].x = 11;

        encoded = state.encode();

        decoded.decode(encoded);

        assert.strictEqual(JSON.stringify(decoded.players.map(p => p.x)), "[11,2,3]");
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

        assert.strictEqual(2, decoded.map.size);
        assert.strictEqual(1, decoded.map.get("one"));
        assert.strictEqual(2, decoded.map.get("two"));

        assert.strictEqual(1, decoded.map["one"]);
        assert.strictEqual(2, decoded.map["two"]);

        delete state.map['one'];

        const encoded = state.encode();

        decoded.decode(encoded);

        assert.strictEqual(1, decoded.map.size);
        assert.strictEqual(undefined, decoded.map["one"]);
        assert.strictEqual(2, decoded.map["two"]);
    });

    describe("re-using Schema references", () => {
        it("should re-use the same Schema reference across the structure", () => {
            class Player extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }

            class State extends Schema {
                @type(Player) player;
                @type({ map: Player }) players = new Map<string, Player>();
            }

            const player = new Player();
            player.x = 1;
            player.y = 2;

            const state = new State();
            state.player = player;
            state.players.set("one", player);
            state.players.set("two", player);
            state.players.set("three", player);

            let encoded = state.encode();

            const decoded = new State();
            decoded.decode(encoded);

            assert.strictEqual(decoded.player, decoded.players.get("one"));
            assert.strictEqual(decoded.player, decoded.players.get("two"));
            assert.strictEqual(decoded.player, decoded.players.get("three"));
        });

        it("re-using Schema references while deleting some", () => {
            class Player extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }

            class State extends Schema {
                @type(Player) player;
                @type({ map: Player }) players = new Map<string, Player>();
            }

            const player = new Player();
            player.x = 1;
            player.y = 2;

            const state = new State();
            state.player = player;
            state.players.set("one", player);
            state.players.set("two", player);
            state.players.set("three", player);

            let encoded = state.encode();

            const decoded = new State();
            decoded.decode(encoded);

            assert.strictEqual(decoded.player, decoded.players.get("one"));
            assert.strictEqual(decoded.player, decoded.players.get("two"));

            state.player = undefined;
            state.players.delete('three');

            player.x = 11;
            player.y = 22;

            //
            // FIXME:
            // this is necessary to re-establish "parent" relation
            //
            state.players.set("two", player);

            encoded = state.encode();
            decoded.decode(encoded);

            assert.strictEqual(decoded.players.get("one"), decoded.players.get("two"));
            assert.strictEqual(undefined, decoded.players.get("three"));
            assert.strictEqual(decoded.players.get("one").x, 11);
            assert.strictEqual(decoded.players.get("one").y, 22);
        });
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

        let encoded = state.encode(undefined, undefined, true);

        let encoded1 = state.applyFilters(client1);
        let encoded2 = state.applyFilters(client2);
        let encoded3 = state.applyFilters(client3);

        decoded1.decode(encoded1);
        assert.strictEqual(decoded1.map.size, 1);
        assert.strictEqual(decoded1.map.get("one"), 1);

        decoded2.decode(encoded2);
        assert.strictEqual(decoded2.map.size, 1);
        assert.strictEqual(decoded2.map.get("two"), 2);

        decoded3.decode(encoded3);
        assert.strictEqual(decoded3.map.size, 1);
        assert.strictEqual(decoded3.map.get("three"), 3);

        // discard previous changes
        state.discardAllChanges();

        // mutate "two" key.
        state.map.set("two", 22);
        encoded = state.encode(undefined, undefined, true);

        encoded1 = state.applyFilters(client1);
        encoded2 = state.applyFilters(client2);
        encoded3 = state.applyFilters(client3);

        decoded1.decode(encoded1);
        assert.strictEqual(decoded1.map.size, 1);

        decoded2.decode(encoded2);
        assert.strictEqual(decoded2.map.size, 1);
        assert.deepEqual(decoded2.map.get("two"), 22);

        decoded3.decode(encoded3);
        assert.strictEqual(decoded3.map.size, 1);
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

        let encoded = state.encode(undefined, undefined, true);

        let encoded1 = state.applyFilters(client1);
        let encoded2 = state.applyFilters(client2);
        let encoded3 = state.applyFilters(client3);

        decoded1.decode(encoded1);
        assert.strictEqual(decoded1.map.size, 1);
        assert.strictEqual(decoded1.map.get("one").x, 1);

        decoded2.decode(encoded2);
        assert.strictEqual(decoded2.map.size, 1);
        assert.strictEqual(decoded2.map.get("two").x, 2);

        decoded3.decode(encoded3);
        assert.strictEqual(decoded3.map.size, 1);
        assert.strictEqual(decoded3.map.get("three").x, 3);

        // discard previous changes
        state.discardAllChanges();

        // mutate all items
        state.map.get("one").x = 11;
        state.map.get("two").x = 22;
        state.map.get("three").x = 33;

        encoded = state.encode(undefined, undefined, true);
        encoded1 = state.applyFilters(client1);
        encoded2 = state.applyFilters(client2);
        encoded3 = state.applyFilters(client3);

        decoded1.decode(encoded1);
        assert.strictEqual(decoded1.map.size, 1);
        assert.deepEqual(decoded1.map.get("one").x, 11);

        decoded2.decode(encoded2);
        assert.strictEqual(decoded2.map.size, 1);
        assert.deepEqual(decoded2.map.get("two").x, 22);

        decoded3.decode(encoded3);
        assert.strictEqual(decoded3.map.size, 1);
        assert.deepEqual(decoded3.map.get("three").x, 33);
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

        const decoded = new State();
        decoded.decode(encoded);

        state.num = 1;
        state.player.x = 2;
        state.player.item.damage = 6;

        encoded = state.encode();
        decoded.decode(encoded);
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

        let encoded = state.encode(undefined, undefined, true);
        let encoded1 = state.applyFilters(client1);

        const decoded1 = new State();
        decoded1.decode(encoded1);

        let encoded2 = state.applyFilters(client2);

        const decoded2 = new State();
        decoded2.decode(encoded2);
        assert.strictEqual("Hello", decoded2.str);

        state.discardAllChanges();

        state.num = 1;
        state.player.x = 2;
        state.player.item.damage = 6;

        encoded = state.encode(undefined, undefined, true);

        encoded1 = state.applyFilters(client1);
        decoded1.decode(encoded1);

        encoded2 = state.applyFilters(client2);
        decoded2.decode(encoded2);
        assert.strictEqual(1, decoded2.num);

        assert.strictEqual(2, decoded1.player.x);
        assert.strictEqual(6, decoded1.player.item.damage);
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

        const patch = state.encode();
        const decoded = new State();
        decoded.decode(patch);

        assert.strictEqual(2, decoded.players.size);
        assert.strictEqual(1, decoded.players.get("one").items.size);
        assert.strictEqual("player one item 1", decoded.players.get("one").items.get("i1").name);
        assert.strictEqual(1, decoded.players.get("two").items.size);
        assert.strictEqual("player two item 2", decoded.players.get("two").items.get("i2").name);
    });

    describe("multiple references to the same instance", () => {
        it("should not consider item removed from root references", () => {
            class Player extends Schema {
                @type("string") name: string;
            }
            class State extends Schema {
                @type({ map: Player }) players = new Map<string, Player>();
                @type(Player) player: Player;
            }

            const player1 = new Player();
            player1.name = "One";

            const player2 = new Player();
            player2.name = "Two";

            const state = new State();
            state.players.set("one", player1);
            state.players.set("two", player2);

            const decoded = new State();
            decoded.decode(state.encode());
            assert.strictEqual(2, decoded.players.size, "should have 2 items");

            const noChangesEncoded = state.encode();

            // remove "two"
            state.players.delete("two");

            decoded.decode(state.encode());
            assert.strictEqual(1, decoded.players.size, "should have 1 items");

            // mutate previous "two" reference.
            player2.name = "Not inside the Map anymore";

            const shouldHaveNoChanges = state.encode();
            assert.deepEqual(noChangesEncoded, shouldHaveNoChanges, "encoded result should be empty.");

            state.player = player2;
            decoded.decode(state.encode());

            assert.strictEqual("Not inside the Map anymore", decoded.player.name);
        });

        it("re-assigning schema multiple times should be allowed", () => {
            class Player extends Schema {
                @type("string") name: string;
            }
            class State extends Schema {
                @type({ map: Player }) players = new Map<string, Player>();
                @type(Player) player: Player;
            }

            const player1 = new Player();
            player1.name = "One";

            const state = new State();
            state.players.set("one", player1);
            state.players.set("one", player1);
            state.players.set("one", player1);
            state.player = player1;
            state.player = player1;
            state.player = player1;

            const decoded = new State();
            decoded.decode(state.encode());

            state.players.delete("one");
            state.player = undefined;

            decoded.decode(state.encode());

            player1.name = "This field should not be encoded!";
            state.players.set("one", player1);
            state.player = player1;
            state.players.set("one", player1);
        });

        it("re-assigning schema multiple times before attaching to root should be allowed", () => {
            class Player extends Schema {
                @type("string") name: string;
            }
            class Child extends Schema {
                @type({ map: Player }) players;
                @type(Player) player: Player;
            }
            class State extends Schema {
                @type(Child) child: Child;
            }

            const players = new Map<string, Player>();

            const player1 = new Player();
            player1.name = "One";

            const child = new Child();
            players.set("one", player1);
            players.set("one", player1);
            players.set("one", player1);

            child.players = players;
            child.player = player1;
            child.player = player1;
            child.player = player1;

            const state = new State();
            state.child = child;

            const decoded = new State();
            decoded.decode(state.encode());

            assert.strictEqual(1, decoded.child.players.size);
            assert.strictEqual(decoded.child.player, decoded.child.players.get("one"));

            state.child.players.delete("one");
            state.child.player = undefined;

            decoded.decode(state.encode());
            assert.strictEqual(0, decoded.child.players.size);
            assert.strictEqual(undefined, decoded.child.player);

            player1.name = "This field should not be encoded!";

            const encoded = state.encode();
            assert.strictEqual(0, encoded.length);
        });

    });


});
