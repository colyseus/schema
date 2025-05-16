import * as assert from "assert";

import { State, Player, getCallbacks, createInstanceFromReflection, getDecoder, getEncoder, assertDeepStrictEqualEncodeAll, assertRefIdCounts } from "./Schema";
import { MapSchema, type, Schema, ArraySchema, Reflection, $changes, SetSchema, entity } from "../src";
import { nanoid } from "nanoid";

describe("Type: MapSchema", () => {

    describe("Internals", () => {
        it("Symbol.species", () => {
            assert.strictEqual(MapSchema[Symbol.species], MapSchema);
        });
    });

    it("should allow to pre-populate a Map", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>({
            jake: new Player("Jake"),
            katarina: new Player("Katarina"),
        });

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.deepStrictEqual(Array.from(decodedState.mapOfPlayers.keys()), ['jake', 'katarina']);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("using number as key should not throw error", async () => {
        class Player extends Schema {
            @type("number") pos: number = 0;
        }
        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }
        const state = new State();
        // @ts-ignore
        state.players.set(3, new Player());
        assert.doesNotThrow(() => state.encodeAll());

        assertDeepStrictEqualEncodeAll(state);
    });

    it("forEach()", () => {
        const map = new MapSchema<number>();
        map.set('one', 1);
        map.set('two', 2);
        map.set('three', 3);

        const keys = [];
        const values = [];

        map.forEach((value, key) => {
            keys.push(key);
            values.push(value);
        });

        assert.deepStrictEqual(keys, ['one', 'two', 'three']);
        assert.deepStrictEqual(values, [1, 2, 3]);
    });

    it("should allow to clear a Map", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema();
        state.mapOfPlayers.set("one", new Player().assign({ name: "Jake", x: 0, y: 0 }))
        state.mapOfPlayers.set("two", new Player().assign({ name: "Katarina", x: 1, y: 1 }))

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(2, decodedState.mapOfPlayers.size);

        state.mapOfPlayers.clear();
        decodedState.decode(state.encode());
        assert.strictEqual(0, decodedState.mapOfPlayers.size);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to CLEAR and ADD in the same patch", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema();
        state.mapOfPlayers.set("one", new Player().assign({ name: "Jake", x: 0, y: 0 }))
        state.mapOfPlayers.set("two", new Player().assign({ name: "Katarina", x: 1, y: 1 }))

        const decodedState = new State();
        decodedState.decode(state.encode());

        state.mapOfPlayers.clear();
        state.mapOfPlayers.set("three", new Player().assign({ name: "Three", x: 10, y: 10 }));
        decodedState.decode(state.encode());

        assert.deepStrictEqual({
            mapOfPlayers: {
                three: { name: "Three", x: 10, y: 10 }
            }
        }, state.toJSON());

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to CLEAR and REPLACE in the same patch", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema();
        state.mapOfPlayers.set("one", new Player().assign({ name: "Jake", x: 0, y: 0 }))
        state.mapOfPlayers.set("two", new Player().assign({ name: "Katarina", x: 1, y: 1 }))

        const decodedState = new State();
        decodedState.decode(state.encode());

        state.mapOfPlayers.clear();
        state.mapOfPlayers.set("two", new Player().assign({ name: "Jake again", x: 10, y: 10 }));

        decodedState.decode(state.encode());

        assert.deepStrictEqual({
            mapOfPlayers: {
                two: { name: "Jake again", x: 10, y: 10 }
            }
        }, state.toJSON());

        assertDeepStrictEqualEncodeAll(state);
    });

    /*
    it("should allow to clear a Map while using filters", () => {
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

        // clear map
        state.map.clear();

        encoded = state.encode(undefined, undefined, true);
        encoded1 = state.applyFilters(client1);
        encoded2 = state.applyFilters(client2);
        encoded3 = state.applyFilters(client3);

        decoded1.decode(encoded1);
        assert.strictEqual(decoded1.map.size, 0);

        decoded2.decode(encoded2);
        assert.strictEqual(decoded2.map.size, 0);

        decoded3.decode(encoded3);
        assert.strictEqual(decoded3.map.size, 0);
    });
    */

    it("should not consider changes after removing from the change tree", () => {
        class Item extends Schema {
            @type("number") price: number;
            constructor (price: number) {
                super();
                this.price = price;
            }
        }
        class Inventory extends Schema {
            @type({ map: Item }) slots = new MapSchema<Item>();
        }
        class Player extends Schema {
            @type("string") name: string;
            @type(Inventory) inventory = new Inventory();
            @type(Inventory) purchase = new Inventory();
        }

        class State extends Schema {
            @type({map: Player}) players = new MapSchema<Player>();
        }

        const state = new State();
        const playerOne = new Player();
        state.players['one'] = playerOne;

        playerOne.name = "One!";
        playerOne.inventory.slots['one'] = new Item(100);
        playerOne.inventory.slots['two'] = new Item(100);
        playerOne.inventory.slots['three'] = new Item(100);

        state.encodeAll();

        const playerTwo = new Player();
        state.players['two'] = playerTwo
        playerTwo.name = "Two!";

        delete state.players['two'];
        playerTwo.name = "Hello";
        playerTwo.purchase.slots['one'] = new Item(500);
        playerTwo.purchase.slots['two'] = new Item(500);
        playerTwo.purchase.slots['three'] = new Item(500);

        state.encode();

        playerTwo.name = "Hello";
        playerTwo.purchase.slots['one'] = new Item(500);
        playerTwo.purchase.slots['two'] = new Item(500);
        playerTwo.purchase.slots['three'] = new Item(500);
        state.encode();

        const decodedState = new State();
        decodedState.decode(state.encodeAll());

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to remove and set an item in the same place", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers.set('one', new Player("Jake"));
        state.mapOfPlayers.set('two', new Player("Katarina"));

        const decodedState = new State();

        let encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Jake");
        assert.strictEqual(decodedState.mapOfPlayers.get('two').name, "Katarina");

        state.mapOfPlayers.delete('one');
        state.mapOfPlayers.set('one', new Player("Jake 2"));

        encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Jake 2");
        assert.strictEqual(decodedState.mapOfPlayers.get('two').name, "Katarina");

        state.mapOfPlayers.delete('two');
        state.mapOfPlayers.set('two', new Player("Katarina 2"));

        encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Jake 2");
        assert.strictEqual(decodedState.mapOfPlayers.get('two').name, "Katarina 2");

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to re-add a removed item from previous patch", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers.set('one', new Player("Jake"));
        state.mapOfPlayers.set('two', new Player("Katarina"));

        const decodedState = new State();

        decodedState.decode(state.encode());

        const one = state.mapOfPlayers.get('one');
        state.mapOfPlayers.delete('one');

        decodedState.decode(state.encode());

        state.mapOfPlayers.set('one', one);

        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);
        assert.strictEqual(decoder.root.refIds.get(decodedState.mapOfPlayers.get('one')), one[$changes].refId);
        assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Jake");
        assertDeepStrictEqualEncodeAll(state);
    });

    it("removing a non-existing item should not remove anything", () => {
        class MyRoomState extends Schema {
            @type({ map: "number" }) duels: MapSchema<number> = new MapSchema();
        }

        const state = new MyRoomState();
        state.duels.set("one", 1);
        state.duels.set("two", 2);

        const decodedState = new MyRoomState();
        decodedState.decode(state.encode());

        state.duels.delete(0 as any);
        decodedState.decode(state.encode());

        assert.deepStrictEqual(Array.from(decodedState.duels.keys()), ['one', 'two']);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("removing item with children should remove children as well", () => {
        class Item extends Schema {
            @type("string") name: string;
        }
        class Entity extends Schema {
            @type("string") name: string;
            @type([Item]) items = new ArraySchema<Item>();
        }
        class State extends Schema {
            @type({map: Entity}) entities = new MapSchema<Entity>();
        }

        const state = new State();
        for (let i = 0; i < 5; i++) {
            state.entities.set("e" + i, new Entity().assign({
                name: "Entity " + i,
                items: [
                    new Item().assign({ name: "Item A" }),
                    new Item().assign({ name: "Item B" }),
                ]
            }));
        }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        assertRefIdCounts(state, decodedState);

        state.entities.delete("e3");
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);
    });

    it("should allow map of primitive types", () => {
        class Player extends Schema {
            @type({ map: "number" }) mapOfNumbers = new MapSchema<number>();
        }
        class State extends Schema {
            @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
        }

        const state = new State();
        state.mapOfPlayers.set('one', new Player());
        state.mapOfPlayers.get('one').mapOfNumbers.set('2', 2);
        state.mapOfPlayers.get('one').mapOfNumbers.set('3', 3);

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepStrictEqual(decodedState.toJSON(), {
            mapOfPlayers: {
                one: {
                    mapOfNumbers: { 2: 2, 3: 3 }
                }
            }
        });

        assertDeepStrictEqualEncodeAll(state);
    });

    it("removing items should have as very few bytes", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers.set('one', new Player("Jake"));
        state.mapOfPlayers.set('two', new Player("Katarina"));
        state.mapOfPlayers.set('three', new Player("Tarquinn"));
        state.mapOfPlayers.set('four', new Player("Snake"));

        state.encode();

        state.mapOfPlayers.delete('one');
        state.mapOfPlayers.delete('two');
        state.mapOfPlayers.delete('three');
        state.mapOfPlayers.delete('four');

        const encoded = state.encode();

        // TODO: we could get lower than that.
        assert.ok(encoded.length <= 12);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should not encode item if added and removed at the same patch (Schema child)", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers.set('one', new Player("Jake", 10, 10));

        // const decodedState = createInstanceFromReflection(state);
        const decodedState = new State();
        const $ = getCallbacks(decodedState);

        let onRemoveCalls = 0;
        let onAddCalls = 0;
        let onChangeCalls = 0;
        $(decodedState).mapOfPlayers.onRemove((value, key) => onRemoveCalls++);
        $(decodedState).mapOfPlayers.onAdd((_, key) => onAddCalls++);
        $(decodedState).mapOfPlayers.onChange((_, key) => onChangeCalls++);

        decodedState.decode(state.encode());

        state.mapOfPlayers.get('one').x++;
        state.mapOfPlayers.set('two', new Player("Snake", 10, 10));
        state.mapOfPlayers.delete('two');

        const patchBytes = state.encode();

        //
        // TODO / FIXME: There's an additional 2 bytes for the "remove" operation here, even though no "add" was made.
        // (the "ADD" + "DELETE" operations on same patch are being encoded as "DELETE")
        // // assert.deepStrictEqual([ 255, 2, 129, 11, 255, 1 ], Array.from(patchBytes));
        //

        decodedState.decode(patchBytes);
        assert.strictEqual(0, onRemoveCalls);

        state.mapOfPlayers.get('one').x++;
        state.mapOfPlayers.delete('one');

        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        assert.strictEqual(1, onRemoveCalls);
        assert.strictEqual(1, onAddCalls);
        assert.strictEqual(2, onChangeCalls);

        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("should not encode item if added and removed at the same patch (primitive child)", () => {
        class MyState extends Schema {
            @type({ map: "string" }) mapOfStrings = new MapSchema<string>();
        }
        const state = new MyState();
        state.mapOfStrings.set('one', "one");

        const decodedState = new MyState();
        const $ = getCallbacks(decodedState);

        let onRemoveCalls = 0;
        let onAddCalls = 0;
        let onChangeCalls = 0;
        $(decodedState).mapOfStrings.onRemove(() => onRemoveCalls++);
        $(decodedState).mapOfStrings.onAdd(() => onAddCalls++);
        $(decodedState).mapOfStrings.onChange(() => onChangeCalls++);

        decodedState.decode(state.encode());

        state.mapOfStrings.set('two', "two");
        state.mapOfStrings.delete('two');

        const patchBytes = state.encode();

        //
        // TODO / FIXME: There's an additional 2 bytes for the "remove" operation here, even though no "add" was made.
        // (the "ADD" + "DELETE" operations on same patch are being encoded as "DELETE")
        // // assert.deepStrictEqual([ 255, 2, 129, 11, 255, 1 ], Array.from(patchBytes));
        //

        decodedState.decode(patchBytes);
        assert.strictEqual(0, onRemoveCalls);

        state.mapOfStrings.delete('one');

        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        assert.strictEqual(1, onRemoveCalls);
        assert.strictEqual(1, onAddCalls);
        assert.strictEqual(2, onChangeCalls);

        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("re-assignments should be ignored", () => {
        class State extends Schema {
            @type({map: "number"}) numbers = new MapSchema<number>();
        }
        const state = new State();
        state.numbers.set("one", 1);
        state.numbers.set("two", 2);
        state.numbers.set("three", 3);
        assert.ok(state.encode().length > 0);

        // re-assignments, should not be enqueued
        state.numbers.set("one", 1);
        state.numbers.set("two", 2);
        state.numbers.set("three", 3);
        assert.ok(state.encode().length === 0);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should consider the field of map schema value change", () => {
        class Player extends Schema {
            @type("string") id: string
            @type("string") name: string;
            @type('uint16') age: number;
            @type("string") next: string;
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const decodedState = new State()

        const p1 = new Player().assign({ id: "76355" });
        state.players.set(p1.id, p1);
        p1.name = "Player One!";
        p1.age = 100;
        p1.next = p1.id;//1->1;
        decodedState.decode(state.encode());

        const p2 = new Player().assign({ id: "8848" });
        state.players.set(p2.id, p2);
        p2.name = "Player Two!";
        p2.age = 200;
        p1.next = p2.id;//1->2;
        p2.next = p1.id;//2->1;
        decodedState.decode(state.encode());

        const p3 = new Player().assign({ id: "8658" });
        state.players.set(p3.id, p3);
        p3.name = "Player Three!";
        p3.age = 300;
        p1.next = p2.id;//1->2;
        p2.next = p3.id;//2->3
        p3.next = p1.id;//3->1
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual(decodedState.players.get('76355').next,'8848');//1->2
        assert.strictEqual(decodedState.players.get('8848').next,'8658');//2->3
        assert.strictEqual(decodedState.players.get('8658').next,'76355')//3->1

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should iterate though map values", () => {
        const map = new MapSchema<number>();
        map.set("one", 1);
        map.set("two", 2);
        map.set("three", 3);
        map.set("four", 4);
        map.set("five", 5);

        const keys: string[] = [];
        const values: number[] = [];

        for (const key of map.keys()) {
            keys.push(key);
        }
        for (const num of map.values()) {
            values.push(num);
        }

        assert.deepStrictEqual(['one', 'two', 'three', 'four', 'five'], keys);
        assert.deepStrictEqual([1, 2, 3, 4, 5], values);
    });

    it("should allow adding and removing same key multiple times", () => {
        class Action extends Schema {
            @type("string") type: string;
        }

        class Entity extends Schema {
            @type("number") id: number;
            @type(Action) action: Action;
        }

        class Item extends Entity {
            @type("number") damage: number;
        }

        class Player extends Entity {
            @type("number") hp: number;
        }

        class State extends Schema {
            @type(["number"]) grid = new ArraySchema<number>();
            @type({ map: Entity }) entities = new MapSchema<Entity>();
        }

        const state = new State();
        state.grid.push(0, 1, 0, 1, 0, 1, 0, 1, 0);

        const decodedState = new State();
        decodedState.decode(state.encode());

        state.entities.set("item1", new Item().assign({ id: 1, damage: 10 }));
        state.entities.set("item2", new Item().assign({ id: 2, damage: 20 }));
        state.entities.set("item3", new Item().assign({ id: 3, damage: 20 }));
        state.entities.set("item4", new Item().assign({ id: 4, damage: 20 }));
        state.entities.set("item5", new Item().assign({ id: 5, damage: 20 }));
        state.entities.set("item6", new Item().assign({ id: 6, damage: 20 }));
        state.entities.set("item7", new Item().assign({ id: 7, damage: 20 }));
        state.entities.set("item8", new Item().assign({ id: 8, damage: 20 }));
        state.entities.set("item9", new Item().assign({ id: 9, damage: 20 }));
        state.entities.set("player1", new Player().assign({ id: 10, hp: 100 }));

        decodedState.decode(state.encode());

        state.entities.delete("item1");
        state.entities.delete("player1");

        decodedState.decode(state.encode());

        const decodedState2 = new State();
        state.entities.set("player1", new Player().assign({ id: 3, hp: 100 }));

        decodedState2.decode(state.encodeAll());

        state.entities.delete("item2");

        const encodedPatch = state.encode();
        decodedState.decode(encodedPatch);
        decodedState2.decode(encodedPatch);

        assert.strictEqual(false, decodedState2.entities.has("item1"), "'item1' should've been deleted.");
        assert.strictEqual(false, decodedState2.entities.has("item2"), "'item2' should've been deleted.");

        assertRefIdCounts(state, decodedState);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to move a key from one map to another", () => {
        class Entity extends Schema {
            @type("number") id: number;
        }

        class Item extends Entity {
            @type("number") damage: number;
        }

        class Player extends Entity {
            @type("number") hp: number;
        }

        class State extends Schema {
            @type({ map: Entity }) entities = new MapSchema<Entity>();
            @type({ map: Entity }) items = new MapSchema<Entity>();
        }

        const state = new State();

        const decodedState = new State();
        const $ = getCallbacks(decodedState);
        decodedState.decode(state.encodeAll());

        state.entities.set("item1", new Item().assign({ id: 1, damage: 10 }));
        state.entities.set("item2", new Item().assign({ id: 2, damage: 20 }));
        state.entities.set("player1", new Player().assign({ id: 10, hp: 100 }));
        state.items.set("weapon", new Item().assign({ id: 3, damage: 999 }));;

        decodedState.decode(state.encode());

        let onEntityAddCount = 0;
        $(decodedState).entities.onAdd(() => onEntityAddCount++, false);
        $(decodedState).entities.onRemove((item, key) => {})

        let onItemAddCount = 0;
        $(decodedState).items.onAdd((item, key) => onItemAddCount++, false)
        $(decodedState).items.onRemove((item, key) => { })

        const item1 = state.entities.get("item1");
        const previousWeapon = state.items.get("weapon");

        state.items.set("weapon", item1.clone());
        state.entities.set("item3", previousWeapon);

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.deepStrictEqual({
            entities: {
                item1: { id: 1, damage: 10 },
                item2: { id: 2, damage: 20 },
                player1: { id: 10, hp: 100 },
                item3: { id: 3, damage: 999 }
            },
            items: { weapon: { id: 1, damage: 10 } }
        }, decodedState.toJSON());

        assert.strictEqual(1, onEntityAddCount);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("replacing MapSchema should trigger onRemove on previous items", () => {
        class State extends Schema {
            @type({ map: "number" }) numbers: MapSchema<number>;
        }

        const state = new State();
        state.numbers = new MapSchema({ one: 1, two: 2, three: 3 });

        const decodedState = new State();
        const $ = getCallbacks(decodedState);
        decodedState.decode(state.encode());

        let onRemoveCalls = 0;
        $(decodedState).numbers.onRemove(() => onRemoveCalls++);

        state.numbers = new MapSchema({ four: 1, five: 2, six: 3 });
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual(3, onRemoveCalls);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should throw error trying to set null or undefined", () => {
        const map = new MapSchema<number>();

        assert.throws(() => {
            map.set("key", undefined);
        }, /undefined/i);

        assert.throws(() => {
            map.set("key", null);
        }, /null/i);
    })

    it("should allow providing MapSchema as argument on constructor", () => {
        var map: MapSchema<number>;

        const previousMap = new MapSchema<number>();
        previousMap.set('one', 1);
        previousMap.set('two', 2);
        previousMap.set('three', 3);

        assert.doesNotThrow(() => map = new MapSchema<number>(previousMap));
        assert.deepStrictEqual(map.toJSON(), previousMap.toJSON());

        assert.doesNotThrow(() => map = new MapSchema<number>(previousMap.toJSON()));
        assert.deepStrictEqual(map.toJSON(), previousMap.toJSON());
    });

    it("should trigger warning: 'trying to remove refId with 0 refCount'", () => {
        enum Synergy { NORMAL = "NORMAL", GRASS = "GRASS", FIRE = "FIRE", WATER = "WATER", ELECTRIC = "ELECTRIC", FIGHTING = "FIGHTING", }
        class Pokemon extends Schema {
            @type("string") name: string;
            @type({ set: "string" }) types = new SetSchema<Synergy>();
        }
        @entity
        class Pikachu extends Pokemon {
            name = "Pikachu";
            types = new SetSchema<Synergy>([Synergy.ELECTRIC]);
        }
        class Player extends Schema {
            @type({ map: Pokemon }) board = new MapSchema<Pokemon>();
        }
        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const decodedState = createInstanceFromReflection(state);

        const player = new Player();
		state.players.set("one", player);
		player.board.set("1", new Pikachu());

        decodedState.decode(state.encode());

        player.board.delete("1");
        decodedState.decode(state.encode());

        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    });

    xit("move instance between keys in the same patch", () => {
        //
        // TODO: test $onEncodeEnd of MapSchema. Is $onEncodeEnd of MapSchema even necessary?
        //
        const state = new State();
        const decodedState = new State();

        state.mapOfPlayers = new MapSchema();
        state.mapOfPlayers.set("one", new Player().assign({ name: "Jake", x: 0, y: 0 }))
        decodedState.decode(state.encode());

        state.mapOfPlayers.set("two", state.mapOfPlayers.get("one"));
        state.mapOfPlayers.delete("one");
        decodedState.decode(state.encode());

        assertDeepStrictEqualEncodeAll(state);
    });

});
