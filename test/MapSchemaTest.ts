import * as sinon from "sinon";
import * as assert from "assert";
import * as util from "util";

import { State, Player } from "./Schema";
import { MapSchema, type, Schema } from "../src";

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

    it("should not consider changes after removing from the change tree", (done) => {
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
        playerOne.inventory['one'] = new Item(100);
        playerOne.inventory['two'] = new Item(100);
        playerOne.inventory['three'] = new Item(100);

        state.encodeAll();

        const playerTwo = new Player();
        state.players['two'] = playerTwo
        playerTwo.name = "Two!";

        delete state.players['two'];
        playerTwo.name = "Hello";
        playerTwo.purchase['one'] = new Item(500);
        playerTwo.purchase['two'] = new Item(500);
        playerTwo.purchase['three'] = new Item(500);

        state.encode();

        playerTwo.name = "Hello";
        playerTwo.purchase['one'] = new Item(500);
        playerTwo.purchase['two'] = new Item(500);
        playerTwo.purchase['three'] = new Item(500);
        state.encode();

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        console.log(decodedState.toJSON());
        done();
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

        assert.equal(10, encoded.length);
    });

    xit("should not encode item if added and removed at the same patch", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("Jake", 10, 10);

        const decodedState = new State();
        decodedState.mapOfPlayers = new MapSchema<Player>();

        decodedState.mapOfPlayers.onRemove = function(item, key) {}
        const onRemoveSpy = sinon.spy(decodedState.mapOfPlayers, 'onRemove');

        decodedState.decode(state.encode());

        state.mapOfPlayers['one'].x++;
        state.mapOfPlayers['two'] = new Player("Snake", 10, 10);
        delete state.mapOfPlayers['two'];

        const patchBytes = state.encode();
        assert.deepEqual([ 4, 1, 0, 1, 11, 193 ], patchBytes);

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
});
