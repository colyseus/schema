import * as sinon from "sinon";
import * as assert from "assert";

import { State, Player } from "./Schema";
import { ArraySchema, Schema, type } from "../src";

describe("ArraySchema", () => {

    it("should allow .sort()", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 0));
        state.arrayOfPlayers.push(new Player("Three", 20, 0));
        state.arrayOfPlayers.push(new Player("Four", 50, 0));
        state.arrayOfPlayers.push(new Player("Five", 40, 0));

        const decodedState = new State();
        decodedState.arrayOfPlayers = new ArraySchema<Player>();

        decodedState.arrayOfPlayers.onAdd = function(item, i) {};
        const onAddSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

        decodedState.arrayOfPlayers.onChange = function(item, i) {};
        const onChangeSpy = sinon.spy(decodedState.arrayOfPlayers, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 0);

        state.arrayOfPlayers.sort((a, b) => 1);

        const encoded = state.encode();
        assert.equal(encoded.length, 23, "should encode only index changes");
        decodedState.decode(encoded);

        assert.deepEqual(decodedState.arrayOfPlayers.map(p => p.name), [ 'Five', 'Four', 'Three', 'Two', 'One' ]);
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 5);

        state.arrayOfPlayers.sort((a, b) => b.x - a.x);
        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 10);

        for (var a = 0; a < 100; a++) {
            for (var b = 0; b < state.arrayOfPlayers.length; b++) {
                var player = state.arrayOfPlayers[b];
                player.x = Math.floor(Math.random() * 100000);
            }

            state.arrayOfPlayers.sort((a, b) => b.x - a.x);
            decodedState.decode(state.encode());
            sinon.assert.callCount(onAddSpy, 5);
        }
    });

    xit("updates all items custom `idx` after removing middle item", () => {
        /**
         * In this scenario, after splicing middle item, I'm updating
         * each item's `idx` property, to reflect its current "index".
         * After remiving "Item 3", items 4 and 5 would get their
         * `idx` updated. Rest of properties should remain unchanged.
         */
        const stringifyItem = i => `[${i.idx}] ${i.name} (${i.id})`;

        class Item extends Schema {
            @type("uint8") id: number;
            @type("uint8") idx: number;
            @type("string") name: string;
            constructor(name, idx) {
                super();
                this.idx = idx
                this.name = name;
                this.id = Math.round(Math.random() * 250);
            }
        }
        class Player extends Schema {
            @type([Item]) items = new ArraySchema<Item>();
        }
        class State extends Schema {
            @type(Player) player1 = new Player();
        }

        const state = new State();
        const decodedState = new State();

        state.player1.items.push(new Item("Item 1", 0));
        state.player1.items.push(new Item("Item 2", 1));
        state.player1.items.push(new Item("Item 3", 2));
        state.player1.items.push(new Item("Item 4", 3));
        state.player1.items.push(new Item("Item 5", 4));
        decodedState.decode(state.encodeAll());
        assert.equal(decodedState.player1.items.length, 5);

        // Remove one item
        state.player1.items.splice(2, 1);
        decodedState.decode(state.encode());
        
        assert.equal(decodedState.player1.items.length, 4);
        
        // Update `idx` of each item
        state.player1.items.forEach((item, idx) => item.idx = idx);
        decodedState.decode(state.encode());

        const resultPreEncoding = state.player1.items
            .map(stringifyItem);
        const resultPostEncoding = decodedState.player1.items
            .map(stringifyItem);

        // Ensure all data is perserved and `idx` is updated for each item
        assert.equal(
            resultPostEncoding,
            resultPreEncoding,
            `There's a difference between state and decoded state on some items`
        );
    })

    xit("updates an item after removing another", () => {
        class Item extends Schema {
            @type("string") name: string;
            constructor(name) {
                super();
                this.name = name;
            }
        }
        class Player extends Schema {
            @type([Item]) items = new ArraySchema<Item>();
        }
        class State extends Schema {
            @type(Player) player = new Player();
        }

        const state = new State();
        const decodedState = new State();

        state.player.items.push(new Item("Item 1"));
        state.player.items.push(new Item("Item 2"));
        state.player.items.push(new Item("Item 3"));
        decodedState.decode(state.encodeAll());

        // Remove Item 2
        const [ removedItem ] = state.player.items.splice(1, 1);
        assert.equal(removedItem.name, "Item 2");
        // If you disable below decoding, the later assertions pass (?!)
        decodedState.decode(state.encode());
        
        // Update `name` of remaining item
        const preEncoding = state.player.items[1].name = "Item 3 changed!";
        decodedState.decode(state.encode());

        assert.equal(
            decodedState.player.items[1].name,
            preEncoding,
            `new name of Item 3 was not reflected during recent encoding/decoding.`
        );
    })

    it("should allow to transfer object between ArraySchema", () => {
        class Item extends Schema {
            @type("uint8") id: number;
            @type("string") name: string;
            constructor(name) {
                super();
                this.name = name;
                this.id = Math.round(Math.random() * 250);
            }
        }
        class Player extends Schema {
            @type([Item]) items = new ArraySchema<Item>();
        }
        class State extends Schema {
            @type(Player) player1 = new Player();
            @type(Player) player2 = new Player();
        }

        const state = new State();
        const decodedState = new State();
        decodedState.decode(state.encodeAll());

        state.player1.items.push(new Item("Item 1"));
        state.player1.items.push(new Item("Item 2"));
        state.player1.items.push(new Item("Item 3"));
        state.player1.items.push(new Item("Item 4"));

        decodedState.decode(state.encode());

        const item1 = state.player1.items[0];
        state.player1.items.splice(0, 1);
        state.player2.items.push(item1);

        decodedState.decode(state.encode());

        assert.equal(decodedState.player1.items[0].name, "Item 2");
        assert.equal(decodedState.player1.items.length, 3);

        assert.equal(decodedState.player2.items[0].name, "Item 1");
        assert.equal(decodedState.player2.items.length, 1);

        state.player2.items.push(state.player1.items.splice(1, 1)[0]);
        decodedState.decode(state.encode());

        assert.equal(decodedState.player1.items.length, 2);
        assert.equal(decodedState.player2.items.length, 2);

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        assert.equal(decodedState.player1.items.length, 1);
        assert.equal(decodedState.player2.items.length, 3);

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        assert.equal(decodedState.player1.items.length, 0);
        assert.equal(decodedState.player2.items.length, 4);

        console.log("FULL 1 >");
        console.log(decodedState.player1.items.map(item => item.name));
        console.log(decodedState.player2.items.map(item => item.name));

        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        console.log("FULL 2 >");
        console.log(decodedState.player1.items.map(item => item.name));
        console.log(decodedState.player2.items.map(item => item.name));

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        console.log("FULL 3 >");
        console.log(decodedState.player1.items.map(item => item.name));
        console.log(decodedState.player2.items.map(item => item.name));
    });

});
