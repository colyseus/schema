import * as sinon from "sinon";
import * as assert from "assert";

import { State, Player } from "./Schema";
import { ArraySchema, Schema, type, Reflection, filter, MapSchema } from "../src";
import { logChangeTree } from "./helpers/test_helpers";

describe("ArraySchema", () => {

    it("should trigger onAdd / onChange / onRemove", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 1));
        state.arrayOfPlayers.push(new Player("Three", 20, 2));

        const decodedState = new State();
        decodedState.arrayOfPlayers = new ArraySchema<Player>();

        decodedState.arrayOfPlayers.onAdd = function(item, i) {};
        const onAddSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

        decodedState.arrayOfPlayers.onChange = function(item, i) {};
        const onChangeSpy = sinon.spy(decodedState.arrayOfPlayers, 'onChange');

        decodedState.arrayOfPlayers.onRemove = function(item, i) {};
        const onRemoveSpy = sinon.spy(decodedState.arrayOfPlayers, 'onRemove');

        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 3);
        sinon.assert.callCount(onChangeSpy, 0);
        sinon.assert.callCount(onRemoveSpy, 0);

        state.arrayOfPlayers[0].x += 100;
        state.arrayOfPlayers.push(new Player("Four", 50, 3));
        state.arrayOfPlayers.push(new Player("Five", 40, 4));

        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 1);
        sinon.assert.callCount(onRemoveSpy, 0);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        decodedState.decode(state.encode());
        sinon.assert.callCount(onRemoveSpy, 2);
    });

    it("should allow .sort()", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 1));
        state.arrayOfPlayers.push(new Player("Three", 20, 2));
        state.arrayOfPlayers.push(new Player("Four", 50, 3));
        state.arrayOfPlayers.push(new Player("Five", 40, 4));

        const decodedState = new State();
        decodedState.arrayOfPlayers = new ArraySchema<Player>();

        decodedState.arrayOfPlayers.onAdd = function(item, i) {};
        const onAddSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

        decodedState.arrayOfPlayers.onChange = function(item, i) {};
        const onChangeSpy = sinon.spy(decodedState.arrayOfPlayers, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 0);

        state.arrayOfPlayers.sort((a, b) => b.y - a.y);

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

    it("should allow to `filter` and then `sort`", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 0));
        state.arrayOfPlayers.push(new Player("Three", 20, 0));

        assert.doesNotThrow(() => {
            state.arrayOfPlayers
                .filter(p => p.x >= 20)
                .sort((a, b) => b.x - a.x);
        }, "arraySchema.filter().sort() shouldn't throw errors");
    });

    // it("filter should not mutate the structure", () => {
    //     class Card extends Schema {
    //         @filter(function(this: Card, client, value, root) {
    //             return true;
    //         })
    //         @type("number") number: number;

    //         constructor(n?) {
    //             super();
    //             if (n) this.number = n;
    //         }
    //     }

    //     class Player extends Schema {
    //         @type([Card]) cards = new ArraySchema<Card>();
    //     }

    //     class StateWithFilter extends Schema {
    //         @type({map: Player}) players = new MapSchema<Player>();
    //     }

    //     const state = new StateWithFilter();
    //     state.players['one'] = new Player();
    //     state.players['one'].cards.push(new Card(1));
    //     state.players['one'].cards.push(new Card(3));
    //     state.players['one'].cards.push(new Card(2));
    //     state.players['one'].cards.push(new Card(5));
    //     state.players['one'].cards.push(new Card(4));

    //     const decodedState = new StateWithFilter();
    //     decodedState.decode(state.encodeAllFiltered({}));

    //     assert.deepEqual([1, 3, 2, 5, 4], decodedState.players['one'].cards.map(c => c.number));
    //     assert.equal(5, decodedState.players['one'].cards.length);

    //     const filteredCards = state.players['one'].cards.filter((card) => card.number >= 3);
    //     filteredCards.sort((a, b) => b.number - a.number);

    //     decodedState.decode(state.encodeFiltered({}));
    //     assert.equal(5, decodedState.players['one'].cards.length);
    //     assert.deepEqual([1, 3, 2, 5, 4], decodedState.players['one'].cards.map(c => c.number));

    //     state.players['one'].cards = filteredCards;
    //     decodedState.decode(state.encodeFiltered({}));
    //     assert.equal(3, decodedState.players['one'].cards.length);
    //     assert.deepEqual([5, 4, 3], decodedState.players['one'].cards.map(c => c.number));
    // });

    it("updates all items `idx` props after removing middle item", () => {
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
                this.idx = idx;
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
        decodedState.decode(state.encodeAll());

        state.player1.items.push(new Item("Item 0", 0));
        state.player1.items.push(new Item("Item 1", 1));
        state.player1.items.push(new Item("Item 2", 2));
        state.player1.items.push(new Item("Item 3", 3));
        state.player1.items.push(new Item("Item 4", 4));
        decodedState.decode(state.encodeAll());
        assert.equal(decodedState.player1.items.length, 5);

        // Remove one item
        state.player1.items.splice(2, 1);
        decodedState.decode(state.encode());

        assert.equal(decodedState.player1.items.length, 4);

        // Update `idx` of each item
        state.player1.items
            .forEach((item, idx) => item.idx = idx);
        // After below encoding, Item 4 is not marked as `changed`
        decodedState.decode(state.encode());

        const resultPreEncoding = state.player1.items
            .map(stringifyItem).join(',');
        const resultPostEncoding = decodedState.player1.items
            .map(stringifyItem).join(',');

        // Ensure all data is perserved and `idx` is updated for each item
        assert.equal(
            resultPostEncoding,
            resultPreEncoding,
            `There's a difference between state and decoded state on some items`
        );
    });

    it("updates an item after removing another", () => {
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
        decodedState.decode(state.encodeAll());

        state.player.items.push(new Item("Item 1"));
        state.player.items.push(new Item("Item 2"));
        state.player.items.push(new Item("Item 3"));
        state.player.items.push(new Item("Item 4"));
        state.player.items.push(new Item("Item 5"));
        decodedState.decode(state.encodeAll());

        // Remove Item 2
        const [ removedItem ] = state.player.items.splice(1, 1);
        assert.equal(removedItem.name, "Item 2");
        decodedState.decode(state.encode());

        // Update `name` of remaining item
        const preEncoding = state.player.items[1].name = "Item 3 changed!";
        decodedState.decode(state.encode());

        assert.equal(
            decodedState.player.items[1].name,
            preEncoding,
            `new name of Item 3 was not reflected during recent encoding/decoding.`
        );
    });

    it("tests splicing one item out and adding it back again", () => {
        /**
         * Scenario: splice out the middle item
         * and push it back at the last index.
         */
        class Item extends Schema {
            @type("string") name: string;
            @type("uint8") x: number;
            constructor(name, x) {
                super();
                this.name = name;
                this.x = x;
            }
        }
        class State extends Schema {
            @type([Item]) items = new ArraySchema();
        }
        // Just updates x position on item
        const updateItem = (item, idx) => item.x = idx * 10;

        const state = new State();
        const decodedState = new State();

        state.items = new ArraySchema<Item>();
        state.items.push(new Item("Item One", 1 * 10));
        state.items.push(new Item("Item Two", 2 * 10));
        state.items.push(new Item("Item Three", 3 * 10));
        state.items.push(new Item("Item Four", 4 * 10));
        state.items.push(new Item("Item Five", 5 * 10));
        decodedState.decode(state.encodeAll());

        /**
         * Splice one item out (and remember its reference)
         */
        const [itemThree] = state.items.splice(2, 1);
        state.items.forEach(updateItem);
        decodedState.decode(state.encodeAll());

        assert.strictEqual(state.items[0].name, 'Item One');
        assert.strictEqual(state.items[1].name, 'Item Two');
        assert.strictEqual(state.items[2].name, 'Item Four');
        assert.strictEqual(state.items[3].name, 'Item Five');

        // ItemThree is forgotten
        assert.strictEqual((state.items as any).$changes.indexMap.get(itemThree), undefined);
        // The rest of the items stay in correct indexes
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[0]), 0);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[1]), 1);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[2]), 2);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[3]), 3);
        assert.strictEqual(
            (state.items as any).$changes.indexMap.size, 4,
            `$changes.indexMap should forget about previously removed item, but it still contains: ${logChangeTree((state.items as any).$changes)}`
        );

        // console.log(
        //     `After splicing one item out`,
        //     logChangeTree((state.items as any).$changes)
        // );

        assert.deepEqual(state.items, decodedState.items);

        /**
         * Add the item back in
         */
        state.items.push(itemThree);
        state.items.forEach(updateItem);
        decodedState.decode(state.encodeAll());

        // console.log(
        //     `After pushing that item back inside`,
        //     logChangeTree((state.items as any).$changes)
        // );

        assert.strictEqual(state.items[0].name, 'Item One');
        assert.strictEqual(state.items[1].name, 'Item Two');
        assert.strictEqual(state.items[2].name, 'Item Four');
        assert.strictEqual(state.items[3].name, 'Item Five');
        assert.strictEqual(state.items[4].name, 'Item Three');

        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[0]), 0);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[1]), 1);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[2]), 2);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[3]), 3);
        assert.strictEqual((state.items as any).$changes.indexMap.get(state.items[4]), 4);
    });

    it("multiple splices in one go", () => {
        const stringifyItem = i => `[${i.idx}] ${i.name} (${i.id})`;

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

        decodedState.decode(state.encode());

        state.player.items.push(new Item("Item 1"));
        state.player.items.push(new Item("Item 2"));
        const item3 = new Item("Item 3")
        state.player.items.push(item3);

        decodedState.decode(state.encode());

        // ========================================

        // Remove Items 1 and 2 in two separate splice executions
        const [ removedItem1 ] = state.player.items.splice(0, 1);
        // It was at index 2
        assert.equal((state.player.items as any).$changes.indexChange.get(item3), 2);

        const [ removedItem2 ] = state.player.items.splice(0, 1);
        // It STILL was at index 2, no decode yet happened
        assert.equal((state.player.items as any).$changes.indexChange.get(item3), 2);

        decodedState.decode(state.encode());

        const resultPreDecoding = state.player.items.map(stringifyItem).join(', ')
        const resultPostDecoding = decodedState.player.items.map(stringifyItem).join(', ')
        assert.equal(resultPreDecoding, resultPostDecoding);

        assert.equal(decodedState.player.items.length, 1);
        assert.equal(decodedState.player.items[0].name, `Item 3`);
    });

    it("keeps items in order after splicing multiple items in one go", () => {
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
        decodedState.decode(state.encodeAll());

        state.player.items.push(new Item("Item 1"));
        state.player.items.push(new Item("Item 2"));
        state.player.items.push(new Item("Item 3"));
        state.player.items.push(new Item("Item 4"));
        state.player.items.push(new Item("Item 5"));
        assert.equal(state.player.items.length, 5);
        decodedState.decode(state.encodeAll());
        assert.equal(decodedState.player.items.length, 5);
        // ========================================

        // Remove Item 1
        const [ removedItem1 ] = state.player.items.splice(0, 1);
        assert.equal(removedItem1.name, "Item 1");
        assert.equal(state.player.items.length, 4);

        assert.strictEqual((state.player.items as any).$changes.indexMap.get(state.player.items[0]), 0);
        assert.strictEqual((state.player.items as any).$changes.indexMap.get(state.player.items[1]), 1);
        assert.strictEqual((state.player.items as any).$changes.indexMap.get(state.player.items[2]), 2);
        assert.strictEqual((state.player.items as any).$changes.indexMap.get(state.player.items[3]), 3);

        decodedState.decode(state.encode());

        assert.equal(decodedState.player.items.length, 4);

        const expectedA = [2, 3, 4, 5];
        decodedState.player.items.forEach((item, index) => {
            assert.equal(item.name, `Item ${expectedA[index]}`);
        })
        // ========================================

        // Remove Items 2 and 3 in two separate splice executions
        const [ removedItem2 ] = state.player.items.splice(0, 1);
        const [ removedItem3 ] = state.player.items.splice(0, 1);

        assert.equal(removedItem2.name, "Item 2");
        assert.equal(removedItem3.name, "Item 3");
        assert.equal(state.player.items.length, 2);

        decodedState.decode(state.encode());

        assert.equal(decodedState.player.items.length, 2);
        const expectedB = [4, 5];
        decodedState.player.items.forEach((item, index) => {
            assert.equal(item.name, `Item ${expectedB[index]}`);
        })
    });

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

    it("should splice an ArraySchema of primitive values", () => {
        class Player extends Schema {
            @type(["string"]) itemIds = new ArraySchema<string>();
        }
        class State extends Schema {
            @type(Player) player = new Player();
        }

        const state = new State();
        const decodedState = new State();
        decodedState.decode(state.encodeAll());

        state.player.itemIds.push("Item 1");
        state.player.itemIds.push("Item 2");
        state.player.itemIds.push("Item 3");
        state.player.itemIds.push("Item 4");
        state.player.itemIds.push("Item 5");
        decodedState.decode(state.encodeAll());

        // Remove Item 2
        const [ removedItem ] = state.player.itemIds.splice(1, 1);
        assert.strictEqual(removedItem, "Item 2");
        decodedState.decode(state.encode());

        // Update remaining item
        const preEncoding = state.player.itemIds[1] = "Item 3 changed!";
        decodedState.decode(state.encode());

        assert.strictEqual(
            decodedState.player.itemIds[1],
            preEncoding,
            `new name of Item 3 was not reflected during recent encoding/decoding.`
        );
    });

    it("should allow ArraySchema of repeated primitive values", () => {
        class State extends Schema {
            @type(["string"]) strings = new ArraySchema<string>();
            @type(["number"]) floats = new ArraySchema<number>();
            @type(["number"]) numbers = new ArraySchema<number>();
        };

        const state = new State();
        state.numbers.push(1);
        state.floats.push(Math.PI);
        state.strings.push("one");

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepEqual(["one"], decodedState.strings);
        assert.deepEqual([Math.PI], decodedState.floats);
        assert.deepEqual([1], decodedState.numbers);

        state.numbers.push(1);
        state.floats.push(Math.PI);
        state.strings.push("one");
        decodedState.decode(state.encode());

        assert.deepEqual(["one", "one"], decodedState.strings);
        assert.deepEqual([Math.PI, Math.PI], decodedState.floats);
        assert.deepEqual([1, 1], decodedState.numbers);
    });

    it("should allow sort() unbound array", () => {
        const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
        assert.doesNotThrow(() => arr.sort());
    });

    it("should allow slice() + sort() unbound array", () => {
        const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
        assert.doesNotThrow(() => arr.slice(0).sort());
    });


});
