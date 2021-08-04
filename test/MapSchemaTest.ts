import * as sinon from "sinon";
import * as assert from "assert";
import * as util from "util";

import { State, Player } from "./Schema";
import { MapSchema, type, Schema, filterChildren, SchemaDefinition, ArraySchema } from "../src";

describe("MapSchema Tests", () => {

    it("should allow to pre-populate a Map", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>({
            jake: new Player("Jake"),
            katarina: new Player("Katarina"),
        });

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.deepEqual(Array.from(decodedState.mapOfPlayers.keys()), ['jake', 'katarina']);
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

        assert.deepEqual(keys, ['one', 'two', 'three']);
        assert.deepEqual(values, [1, 2, 3]);
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

        assert.deepEqual({
            mapOfPlayers: {
                three: { name: "Three", x: 10, y: 10 }
            }
        }, state.toJSON());
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

        assert.deepEqual({
            mapOfPlayers: {
                two: { name: "Jake again", x: 10, y: 10 }
            }
        }, state.toJSON());
    });

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
    });

    it("should allow to remove and set an item in the same place", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("Jake");
        state.mapOfPlayers['two'] = new Player("Katarina");

        const decodedState = new State();

        let encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.mapOfPlayers['one'].name, "Jake");
        assert.strictEqual(decodedState.mapOfPlayers['two'].name, "Katarina");

        state.discardAllChanges();

        delete state.mapOfPlayers['one'];
        state.mapOfPlayers['one'] = new Player("Jake 2");

        encoded = state.encode();
        decodedState.decode(encoded);

        state.discardAllChanges();

        assert.strictEqual(decodedState.mapOfPlayers['one'].name, "Jake 2");
        assert.strictEqual(decodedState.mapOfPlayers['two'].name, "Katarina");

        delete state.mapOfPlayers['two'];
        state.mapOfPlayers['two'] = new Player("Katarina 2");

        encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.mapOfPlayers['one'].name, "Jake 2");
        assert.strictEqual(decodedState.mapOfPlayers['two'].name, "Katarina 2");
    });

    it("should allow map of primitive types", () => {
        class Player extends Schema {
            @type({ map: "number" }) mapOfNumbers = new MapSchema<number>();
        }
        class State extends Schema {
            @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
        }

        const state = new State();
        state.mapOfPlayers['one'] = new Player();
        state.mapOfPlayers['one'].mapOfNumbers['2'] = 2;
        state.mapOfPlayers['one'].mapOfNumbers['3'] = 3;

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.toJSON(), {
            mapOfPlayers: {
                one: {
                    mapOfNumbers: { 2: 2, 3: 3 }
                }
            }
        });
    });

    it("removing items should have as very few bytes", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("Jake");
        state.mapOfPlayers['two'] = new Player("Katarina");
        state.mapOfPlayers['three'] = new Player("Tarquinn");
        state.mapOfPlayers['four'] = new Player("Snake");

        state.encode();

        delete state.mapOfPlayers['one'];
        delete state.mapOfPlayers['two'];
        delete state.mapOfPlayers['three'];
        delete state.mapOfPlayers['four'];

        const encoded = state.encode();

        // TODO: we could get lower than that.
        assert.ok(encoded.length <= 12);
    });

    it("should not encode item if added and removed at the same patch", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("Jake", 10, 10);

        const decodedState = new State();
        decodedState.mapOfPlayers = new MapSchema<Player>();

        decodedState.mapOfPlayers.onAdd = function(item, key) {};
        decodedState.mapOfPlayers.onRemove = function(item, key) {};
        const onRemoveSpy = sinon.spy(decodedState.mapOfPlayers, 'onRemove');

        decodedState.decode(state.encode());

        state.mapOfPlayers['one'].x++;
        state.mapOfPlayers['two'] = new Player("Snake", 10, 10);
        delete state.mapOfPlayers['two'];

        const patchBytes = state.encode();

        //
        // TODO: improve me! `DELETE` operation should not be encoded here.
        // this test conflicts with encodeAll() + encode() for other structures, where DELETE operation is necessary.
        // // assert.deepEqual([ 4, 1, 0, 1, 11, 193 ], patchBytes);
        //

        decodedState.decode(patchBytes);
        sinon.assert.notCalled(onRemoveSpy);

        state.mapOfPlayers['one'].x++;
        delete state.mapOfPlayers['one'];

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onRemoveSpy);
    });

    it("should consider the field of map schema value change.", (done) => {
        class Player extends Schema {
            @type("string") id:string
            @type("string") name: string;
            @type('uint16') age:number;
            @type("string") next: string;
            constructor(id:string){
                super()
                this.id = id;
            }
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const decodeState = new State()

        const playerOne = new Player("76355");
        state.players[playerOne.id] = playerOne;
        playerOne.name = "Player One!";
        playerOne.age = 100;
        playerOne.next = playerOne.id;//1->1;
        decodeState.decode(state.encode());

        const playerTwo = new Player("8848");
        state.players[playerTwo.id] = playerTwo
        playerTwo.name = "Player Two!";
        playerTwo.age = 200;
        playerOne.next = playerTwo.id;//1->2;
        playerTwo.next = playerOne.id;//2->1;
        decodeState.decode(state.encode());

        const playerThree = new Player("8658");
        state.players[playerThree.id] = playerThree
        playerThree.name = "Player Three!";
        playerThree.age = 300;
        playerOne.next = playerTwo.id;//1->2;
        playerTwo.next = playerThree.id;//2->3
        playerThree.next = playerOne.id;//3->1
        decodeState.decode(state.encode());

        assert.strictEqual(decodeState.players['76355'].next,'8848');//1->2
        assert.strictEqual(decodeState.players['8848'].next,'8658');//2->3
        assert.strictEqual(decodeState.players['8658'].next,'76355')//3->1
        done();
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

        assert.deepEqual(['one', 'two', 'three', 'four', 'five'], keys);
        assert.deepEqual([1, 2, 3, 4, 5], values);
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
        decodedState.decode(state.encodeAll());

        state.entities.set("item1", new Item().assign({ id: 1, damage: 10 }));
        state.entities.set("item2", new Item().assign({ id: 2, damage: 20 }));
        state.entities.set("player1", new Player().assign({ id: 10, hp: 100 }));
        state.items.set("weapon", new Item().assign({ id: 3, damage: 999 }));;

        decodedState.decode(state.encode());

        decodedState.entities.onAdd = function (item, key) {};
        decodedState.entities.onChange = function (item, key) {}
        decodedState.entities.onRemove = function (item, key) {}
        const onEntityAddSpy = sinon.spy(decodedState.entities, 'onAdd');

        decodedState.items.onAdd = function (item, key) {}
        decodedState.items.onChange = function (item, key) {}
        decodedState.items.onRemove = function (item, key) {}
        const onItemsChangeSpy = sinon.spy(decodedState.items, 'onChange');

        const item1 = state.entities.get("item1");
        const previousWeapon = state.items.get("weapon");

        state.items.set("weapon", item1.clone());
        state.entities.set("item3", previousWeapon);

        decodedState.decode(state.encode());

        assert.deepEqual({
            entities: {
                item1: { id: 1, damage: 10 },
                item2: { id: 2, damage: 20 },
                player1: { id: 10, hp: 100 },
                item3: { id: 3, damage: 999 }
            },
            items: { weapon: { id: 1, damage: 10 } }
        }, decodedState.toJSON());

        sinon.assert.calledOnce(onEntityAddSpy);
        sinon.assert.calledOnce(onItemsChangeSpy);
    });

    it("replacing MapSchema should trigger onRemove on previous items", () => {
        class State extends Schema {
            @type({ map: "number" }) numbers: MapSchema<number>;
        }

        const state = new State();
        state.numbers = new MapSchema({ one: 1, two: 2, three: 3 });

        const decodedState = new State();
        decodedState.decode(state.encode());

        decodedState.numbers.onRemove = function(num, i) {}
        const onRemove = sinon.spy(decodedState.numbers, 'onRemove');

        state.numbers = new MapSchema({ four: 1, five: 2, six: 3 });
        decodedState.decode(state.encode());

        sinon.assert.callCount(onRemove, 3);
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

});
