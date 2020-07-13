import * as sinon from "sinon";
import * as assert from "assert";
import * as util from "util";

import { State, Player } from "./Schema";
import { MapSchema, type, Schema, filterChildren } from "../src";

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
        assert.equal(2, decodedState.mapOfPlayers.size);

        state.mapOfPlayers.clear();
        decodedState.decode(state.encode());
        assert.equal(0, decodedState.mapOfPlayers.size);
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

        let encoded1 = state.applyFilters(encoded, client1);
        let encoded2 = state.applyFilters(encoded, client2);
        let encoded3 = state.applyFilters(encoded, client3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 1);
        assert.equal(decoded1.map.get("one").x, 1);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 1);
        assert.equal(decoded2.map.get("two").x, 2);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 1);
        assert.equal(decoded3.map.get("three").x, 3);

        // discard previous changes
        state.discardAllChanges();

        // clear map
        state.map.clear();

        encoded = state.encode(undefined, undefined, true);
        encoded1 = state.applyFilters(encoded, client1);
        encoded2 = state.applyFilters(encoded, client2);
        encoded3 = state.applyFilters(encoded, client3);

        decoded1.decode(encoded1);
        assert.equal(decoded1.map.size, 0);

        decoded2.decode(encoded2);
        assert.equal(decoded2.map.size, 0);

        decoded3.decode(encoded3);
        assert.equal(decoded3.map.size, 0);
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

        console.log("PLAYER CHANGES =>", state.players['$changes']);

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        console.log(decodedState.toJSON());
    });

    it("should allow to remove and set an item in the same place", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("Jake");
        state.mapOfPlayers['two'] = new Player("Katarina");

        const decodedState = new State();

        let encoded = state.encode();
        console.log("ENCODED", encoded.length, encoded);

        decodedState.decode(encoded);

        assert.equal(decodedState.mapOfPlayers['one'].name, "Jake");
        assert.equal(decodedState.mapOfPlayers['two'].name, "Katarina");

        state.discardAllChanges();

        delete state.mapOfPlayers['one'];
        state.mapOfPlayers['one'] = new Player("Jake 2");

        encoded = state.encode();
        decodedState.decode(encoded);

        state.discardAllChanges();

        assert.equal(decodedState.mapOfPlayers['one'].name, "Jake 2");
        assert.equal(decodedState.mapOfPlayers['two'].name, "Katarina");

        delete state.mapOfPlayers['two'];
        state.mapOfPlayers['two'] = new Player("Katarina 2");

        encoded = state.encode();
        decodedState.decode(encoded);
        console.log("DECODED (3) =>", util.inspect(decodedState.toJSON(), true, Infinity));

        assert.equal(decodedState.mapOfPlayers['one'].name, "Jake 2");
        assert.equal(decodedState.mapOfPlayers['two'].name, "Katarina 2");
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
        console.log(decodeState.toJSON());

        const playerTwo = new Player("8848");
        state.players[playerTwo.id] = playerTwo
        playerTwo.name = "Player Two!";
        playerTwo.age = 200;
        playerOne.next = playerTwo.id;//1->2;
        playerTwo.next = playerOne.id;//2->1;
        decodeState.decode(state.encode());
        console.log(decodeState.toJSON());

        const playerThree = new Player("8658");
        state.players[playerThree.id] = playerThree
        playerThree.name = "Player Three!";
        playerThree.age = 300;
        playerOne.next = playerTwo.id;//1->2;
        playerTwo.next = playerThree.id;//2->3
        playerThree.next = playerOne.id;//3->1
        decodeState.decode(state.encode());
        console.log(decodeState.toJSON());

        assert.equal(decodeState.players['76355'].next,'8848');//1->2
        assert.equal(decodeState.players['8848'].next,'8658');//2->3
        assert.equal(decodeState.players['8658'].next,'76355')//3->1
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

});
