import * as assert from "assert";

import { State, Player, getCallbacks, getEncoder, createInstanceFromReflection, getDecoder, assertDeepStrictEqualEncodeAll } from "./Schema";
import { ArraySchema, Schema, type, Reflection, $changes } from "../src";

describe("ArraySchema Tests", () => {

    describe("Internals", () => {
        it("Symbol.species", () => {
            assert.strictEqual(ArraySchema[Symbol.species], ArraySchema);
        });

        it("should allow to assign a regular array", () => {
            class State extends Schema {
                @type(['number']) cardIdsPool: number[];
            }

            const state = new State();
            state.cardIdsPool = [1, 2, 3, 4, 5];

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode())

            state.cardIdsPool = state.cardIdsPool.filter(id => id < 2);
            decodedState.decode(state.encode())

            assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
        })
    });

    describe("ArraySchema#shift()", () => {
        it("shift + push", () => {
            class State extends Schema {
                @type(["string"]) turns = new ArraySchema<string>();
            }

            const state = new State();
            state.turns.push("one");
            state.turns.push("two");
            state.turns.push("three");

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.strictEqual(3, state.turns.length);
            assert.strictEqual("one", state.turns[0]);
            assert.strictEqual("two", state.turns[1]);
            assert.strictEqual("three", state.turns[2]);

            state.turns.push(state.turns.shift());
            decodedState.decode(state.encode());

            assert.strictEqual("two", state.turns[0]);
            assert.strictEqual("three", state.turns[1]);
            assert.strictEqual("one", state.turns[2]);

            state.turns.push(state.turns.shift());
            decodedState.decode(state.encode());

            assert.strictEqual("three", state.turns[0]);
            assert.strictEqual("one", state.turns[1]);
            assert.strictEqual("two", state.turns[2]);

            state.turns.push(state.turns.shift());
            decodedState.decode(state.encode());

            assert.strictEqual("one", state.turns[0]);
            assert.strictEqual("two", state.turns[1]);
            assert.strictEqual("three", state.turns[2]);

            state.turns.clear();
            decodedState.decode(state.encode());
            assert.strictEqual(0, state.turns.length);
        });
    });

    it("should not crash when pushing an undefined value", () => {
        class Block extends Schema {
            @type("number") num: number;
        }
        class State extends Schema {
            @type([Block]) blocks = new ArraySchema<Block>();
        }
        const state = new State();
        state.blocks.push(new Block().assign({ num: 1 }));
        state.blocks.push(undefined);

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.blocks.length, 1);
        assert.ok(decodedState.blocks.at(0) instanceof Block);
        assert.ok(decodedState.blocks.at(1) === undefined);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should trigger onAdd / onRemove properly on splice", () => {
        class Item extends Schema {
            @type("string") name: string = "no_name";
        }

        class State extends Schema {
            @type([Item]) items = new ArraySchema<Item>();
        }

        const state: State = new State();
        state.items.push(new Item().assign({ name: "A" }));
        state.items.push(new Item().assign({ name: "B" }));
        state.items.push(new Item().assign({ name: "C" }));
        state.items.push(new Item().assign({ name: "D" }));
        state.items.push(new Item().assign({ name: "E" }));

        const decodedState = new State();
        const $ = getCallbacks(decodedState);

        let onAddCount = 0;
        let onRemoveCount = 0;
        let onChangeCount = 0;
        let removedItem: Item;
        $(decodedState).items.onAdd(() => onAddCount++);
        $(decodedState).items.onChange(() => onChangeCount++);
        $(decodedState).items.onRemove((item) => {
            removedItem = item;
            onRemoveCount++;
        });

        decodedState.decode(state.encodeAll());
        assert.strictEqual(5, onAddCount);
        assert.strictEqual(5, onChangeCount);

        // state.items.shift();
        state.items.splice(0, 1);

        decodedState.decode(state.encode());

        assert.strictEqual(1, onRemoveCount);
        assert.strictEqual(6, onChangeCount);
        assert.deepStrictEqual(["B", "C", "D", "E"], decodedState.items.map(it => it.name))
        assert.strictEqual("A", removedItem.name);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should encode array with two values", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(
            new Player("Jake Badlands"),
            new Player("Snake Sanders"),
        );

        const decodedState = new State();

        let encoded = state.encode();
        decodedState.decode(encoded);

        const jake = decodedState.arrayOfPlayers[0];
        const snake = decodedState.arrayOfPlayers[1];

        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.strictEqual(jake.name, "Jake Badlands");
        assert.strictEqual(snake.name, "Snake Sanders");

        state.arrayOfPlayers.push(new Player("Katarina Lyons"));
        encoded = state.encode();
        decodedState.decode(encoded);

        const tarquinn = decodedState.arrayOfPlayers[2];

        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);
        assert.strictEqual(decodedState.arrayOfPlayers[0], jake);
        assert.strictEqual(decodedState.arrayOfPlayers[1], snake);
        assert.strictEqual(tarquinn.name, "Katarina Lyons");

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers[0].name = "Tarquinn"

        encoded = state.encode();
        // assert.deepStrictEqual(encoded, [3, 2, 1, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193]);

        decodedState.decode(encoded);

        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.strictEqual(decodedState.arrayOfPlayers[0], jake);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Tarquinn");
        assert.strictEqual(decodedState.arrayOfPlayers[1], snake);
        assert.strictEqual(decodedState.arrayOfPlayers[2], undefined);
    });

    it("should allow to pop an array", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(new Player("Jake"), new Player("Snake"), new Player("Player 3"));

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);
        state.arrayOfPlayers.pop();

        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.deepStrictEqual(decodedState.arrayOfPlayers.map(p => p.name), ["Jake", "Snake"]);
    });

    it("should allow to pop an array of numbers", () => {
        class State extends Schema {
            @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            @type("string") str: string;
        }

        const state = new State();
        state.arrayOfNumbers.push(1);
        state.arrayOfNumbers.push(2);
        state.arrayOfNumbers.push(3);
        state.arrayOfNumbers.push(4);

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfNumbers.length, 4);
        assert.deepStrictEqual(decodedState.arrayOfNumbers.toArray(), [1,2,3,4]);

        state.arrayOfNumbers.pop();
        state.arrayOfNumbers.pop();

        state.str = "hello!";
        const encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.arrayOfNumbers.length, 2);
        assert.deepStrictEqual(decodedState.arrayOfNumbers.toArray(), [1, 2]);
        assert.strictEqual(decodedState.str, 'hello!');
    });

    describe("ArraySchema#shift()", () => {
        it("shift, push, splice", () => {
            class State extends Schema {
                @type(["string"]) turns = new ArraySchema<string>();
            }

            const state = new State();
            const decodedState = new State();
            const $ = getCallbacks(decodedState);

            state.turns[0] = "one";
            state.turns[1] = "two";
            state.turns[2] = "three";

            const onAddIndexes: Array<{ item: string, index: number }> = [];
            const onRemoveIndexes: Array<{ item: string, index: number }> = [];
            $(decodedState).turns.onAdd((item, index) => {
                console.log("ON ADD", { item, index });
                onAddIndexes.push({ item, index });
            });
            $(decodedState).turns.onRemove((item, index) => {
                console.log("ON REMOVE:", { item, index });
                onRemoveIndexes.push({ item, index });
            });

            decodedState.decode(state.encode());
            console.log("--- 1 ---")

            assert.strictEqual(3, state.turns.length);
            assert.strictEqual("one", state.turns[0]);
            assert.strictEqual("two", state.turns[1]);
            assert.strictEqual("three", state.turns[2]);
            assert.deepStrictEqual(
                [
                    { item: "one", index: 0 },
                    { item: "two", index: 1 },
                    { item: "three", index: 2 }
                ],
                onAddIndexes
            );

            state.turns.push(state.turns.shift());
            state.turns.splice(1, 1);
            decodedState.decode(state.encode());
            console.log("--- 2 ---")

            assert.strictEqual("two", state.turns[0]);
            assert.strictEqual("one", state.turns[1]);
            assert.strictEqual(undefined, state.turns[2]);
            // assert.deepStrictEqual(
            //     [
            //         { item: "one", index: 0 },
            //         { item: "two", index: 1 },
            //         { item: "three", index: 2 },
            //         { item: "one", index: 1 },
            //     ],
            //     onAddIndexes
            // );

            state.turns.push(state.turns.shift());
            decodedState.decode(state.encode());
            console.log("--- 3 ---")

            assert.strictEqual("one", state.turns[0]);
            assert.strictEqual("two", state.turns[1]);

            state.turns.push(state.turns.shift());
            decodedState.decode(state.encode());
            console.log("--- 4 ---")

            assert.strictEqual("two", state.turns[0]);
            assert.strictEqual("one", state.turns[1]);

            state.turns.clear();
            decodedState.decode(state.encode());
            console.log("--- 5 ---")

            assert.strictEqual(0, state.turns.length);
        });
    });

    describe("ArraySchema#unshift()", () => {
        it("only unshift", () => {
            class State extends Schema {
                @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            }

            const state = new State();
            state.arrayOfNumbers.push(1);
            state.arrayOfNumbers.push(2);
            state.arrayOfNumbers.push(3);
            state.arrayOfNumbers.push(4);

            const decodedState = new State();
            decodedState.decode(state.encode());

            // state.arrayOfNumbers.push(5)
            state.arrayOfNumbers.unshift(0);
            assert.strictEqual(0, state.arrayOfNumbers[0]);

            decodedState.decode(state.encode());
            assert.deepStrictEqual([0, 1, 2, 3, 4], decodedState.arrayOfNumbers.toJSON());
        });

        it("push and unshift", () => {
            class State extends Schema {
                @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            }

            const state = new State();
            state.arrayOfNumbers.push(1);
            state.arrayOfNumbers.push(2);
            state.arrayOfNumbers.push(3);

            const decodedState = new State();
            decodedState.decode(state.encode());

            state.arrayOfNumbers.push(4)
            state.arrayOfNumbers.unshift(0);
            assert.strictEqual(0, state.arrayOfNumbers[0]);

            decodedState.decode(state.encode());
            assert.deepStrictEqual([0, 1, 2, 3, 4], decodedState.arrayOfNumbers.toJSON());
        });

        it("push, unshift, pop", () => {
            class State extends Schema {
                @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            }

            const state = new State();
            state.arrayOfNumbers.push(1);
            state.arrayOfNumbers.push(2);
            state.arrayOfNumbers.push(3);

            const decodedState = new State();
            decodedState.decode(state.encode());

            state.arrayOfNumbers.push(4)
            state.arrayOfNumbers.unshift(0);
            state.arrayOfNumbers.pop();

            decodedState.decode(state.encode());
            assert.deepStrictEqual([0, 1, 2, 3], decodedState.arrayOfNumbers.toJSON());
        });

        it("push, pop, unshift", () => {
            class State extends Schema {
                @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            }

            const state = new State();
            state.arrayOfNumbers.push(1);
            state.arrayOfNumbers.push(2);
            state.arrayOfNumbers.push(3);

            const decodedState = new State();
            decodedState.decode(state.encode());

            state.arrayOfNumbers.push(4)
            state.arrayOfNumbers.pop();
            state.arrayOfNumbers.unshift(0);

            decodedState.decode(state.encode());
            assert.deepStrictEqual([0, 1, 2, 3], decodedState.arrayOfNumbers.toJSON());
        });

        it("push, shift, unshift", () => {
            class State extends Schema {
                @type(["number"]) cards = new ArraySchema<number>();
            }

            const state = new State();

            const decodedState = new State();
            decodedState.decode(state.encode());

            state.cards.push(1);
            state.cards.push(2);
            state.cards.shift();
            state.cards.unshift(3);

            assert.strictEqual(3, state.cards[0]);
            assert.strictEqual(3, state.cards.at(0));

            decodedState.decode(state.encode());

            assert.deepStrictEqual(decodedState.cards.toJSON(), state.cards.toJSON());

            assert.strictEqual(3, state.cards[0]);
            assert.strictEqual(3, state.cards[0]);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("push, pop -> encode -> unshift", () => {
            class State extends Schema {
                @type(["number"]) items = new ArraySchema<number>();
            }

            const state = new State();
            const decodedState = createInstanceFromReflection(state);

            state.items.push(1);
            // console.log('push(1)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.push(2);
            // console.log('push(2)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.push(3);
            // console.log('push(3)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.push(4);
            // console.log('push(4)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.push(5);
            // console.log('push(5)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.pop();
            // console.log('pop()', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.pop();
            // console.log('pop()', state.items[$changes].indexedOperations, state.items[$changes].changes);

            state.items.push(9);
            // console.log('push(9)', state.items[$changes].indexedOperations, state.items[$changes].changes);

            decodedState.decode(state.encode());

            assert.deepStrictEqual([ 1, 2, 3, 9 ], decodedState.items.toArray());
            assert.deepStrictEqual([ 1, 2, 3, 9 ], state.items.toArray());

            state.items.unshift(8)
            decodedState.decode(state.encode());

            assert.deepStrictEqual([8, 1, 2, 3, 9], decodedState.items.toArray());
            assert.deepStrictEqual([8, 1, 2, 3, 9], state.items.toArray());

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    it("push, splice, push", () => {
        class State extends Schema {
            @type(["number"]) cards = new ArraySchema<number>();
        }

        const state = new State();
        const decodedState = createInstanceFromReflection(state);
        const $ = getCallbacks(decodedState);

        const onAddIndexes: Array<{ item: number, index: number }> = [];
        const onRemoveIndexes: Array<{ item: number, index: number }> = [];
        $(decodedState).cards.onAdd((item, index) => onAddIndexes.push({ item, index }));
        $(decodedState).cards.onRemove((item, index) => onRemoveIndexes.push({ item, index }));

        decodedState.decode(state.encodeAll());

        state.cards.push(1);
        decodedState.decode(state.encode());

        assert.strictEqual(1, state.cards[0]);
        assert.deepStrictEqual([{ item: 1, index: 0 }], onAddIndexes);

        state.cards.splice(0, 1);
        decodedState.decode(state.encode());

        assert.strictEqual(undefined, state.cards[0]);
        assert.deepStrictEqual([{ item: 1, index: 0 }], onAddIndexes);

        state.cards.push(2);
        decodedState.decode(state.encode());
        assert.strictEqual(2, state.cards[0]);
        assert.deepStrictEqual([{ item: 1, index: 0 }, { item: 2, index: 0 }], onAddIndexes);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow using push/pop before encoding", () => {
        class State extends Schema {
            @type(["number"]) numbers = new ArraySchema<number>();
        }

        const state = new State();

        // push from 10 to 19.
        for (let i=10; i<19; i++) { state.numbers.push(i); }

        // pop last 4 values.
        state.numbers.pop();
        state.numbers.pop();
        state.numbers.pop();
        state.numbers.pop();

        const decoded = new State();
        decoded.decode(state.encode());

        assert.strictEqual(decoded.numbers.length, 5);
        assert.strictEqual(decoded.numbers[0], 10);
        assert.strictEqual(decoded.numbers[1], 11);
        assert.strictEqual(decoded.numbers[2], 12);
        assert.strictEqual(decoded.numbers[3], 13);
        assert.strictEqual(decoded.numbers[4], 14);

        // push from 20 to 29.
        for (let i=20; i<29; i++) { state.numbers.push(i); }

        // pop last 4 values.
        state.numbers.pop();
        state.numbers.pop();
        state.numbers.pop();
        state.numbers.pop();

        decoded.decode(state.encode());

        assert.strictEqual(decoded.numbers.length, 10);
        assert.strictEqual(decoded.numbers[0], 10);
        assert.strictEqual(decoded.numbers[1], 11);
        assert.strictEqual(decoded.numbers[2], 12);
        assert.strictEqual(decoded.numbers[3], 13);
        assert.strictEqual(decoded.numbers[4], 14);
        assert.strictEqual(decoded.numbers[5], 20);
        assert.strictEqual(decoded.numbers[6], 21);
        assert.strictEqual(decoded.numbers[7], 22);
        assert.strictEqual(decoded.numbers[8], 23);
        assert.strictEqual(decoded.numbers[9], 24);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow using push/pop between patches", () => {
        class State extends Schema {
            @type(["number"]) numbers = new ArraySchema<number>();
        }

        const state = new State();

        // push from 10 to 15.
        for (let i = 10; i < 15; i++) {
            state.numbers.push(i);
        }

        const decoded = new State();
        decoded.decode(state.encode());

        assert.strictEqual(decoded.numbers.length, 5);

        state.numbers.pop();
        state.numbers.pop();

        // push from 20 to 25.
        for (let i = 20; i < 25; i++) {
            state.numbers.push(i);
        }

        // remove latest ADD value
        state.numbers.pop();

        decoded.decode(state.encode());

        assert.strictEqual(decoded.numbers.length, 7);
        assert.strictEqual(decoded.numbers[0], 10);
        assert.strictEqual(decoded.numbers[1], 11);
        assert.strictEqual(decoded.numbers[2], 12);
        assert.strictEqual(decoded.numbers[3], 20);
        assert.strictEqual(decoded.numbers[4], 21);
        assert.strictEqual(decoded.numbers[5], 22);
        assert.strictEqual(decoded.numbers[6], 23);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should not encode a higher number of items than array actually have", () => {
        // Thanks @Ramus on Discord
        class State extends Schema {
            @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
            @type(["number"]) anotherOne = new ArraySchema<number>();
        }

        const state = new State();

        state.arrayOfNumbers.push(0, 0, 0, 1, 1, 1, 2, 2, 2);
        assert.strictEqual(state.arrayOfNumbers.length, 9);

        //
        // TODO: when re-assigning another ArraySchema, the previous one is
        // still being held at the $root level.
        //
        // // state.arrayOfNumbers = new ArraySchema<number>(...[0, 0, 0, 1, 1, 1, 2, 2, 2]);
        // // assert.strictEqual(state.arrayOfNumbers.length, 9);

        // console.log("CHANGES (1) =>", dumpChanges(state));

        for (let i = 0; i < 5; i++) {
            const value = state.arrayOfNumbers.pop();
            state.anotherOne.push(value);
        }

        assert.strictEqual(state.arrayOfNumbers.length, 4);
        assert.strictEqual(state.anotherOne.length, 5);

        // console.log("CHANGES (2) =>", dumpChanges(state));

        const encoded = state.encode();
        // console.log("ENCODED:", encoded.length, encoded);

        const decodedState = new State();
        decodedState.decode(encoded);

        // console.log("DECODED =>", decodedState.toJSON());
        assert.strictEqual(decodedState.anotherOne.length, 5);
        assert.strictEqual(decodedState.arrayOfNumbers.length, 4);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to shift an array", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(new Player("Jake"), new Player("Snake"), new Player("Cyberhawk"));

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);

        const snake = decodedState.arrayOfPlayers[1];
        const cyberhawk = decodedState.arrayOfPlayers[2];

        // BATTLE OF MOVING INDEXES!

        state.arrayOfPlayers[1].name = "Snake updated!";
        // console.log("BEFORE SHIFT =>", state.arrayOfPlayers.toArray().map(n => n.name));
        state.arrayOfPlayers.shift();
        // console.log("AFTER SHIFT =>", state.arrayOfPlayers.toArray().map(n => n.name));
        state.arrayOfPlayers[1].name = "Cyberhawk updated!";

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Snake updated!");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "Cyberhawk updated!");
        assert.strictEqual(snake, decodedState.arrayOfPlayers[0]);
        assert.strictEqual(cyberhawk, decodedState.arrayOfPlayers[1]);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to splice an array", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(
            new Player("Jake"),
            new Player("Snake"),
            new Player("Cyberhawk"),
        );

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);

        const jake = decodedState.arrayOfPlayers[0];

        const removedItems = state.arrayOfPlayers.splice(1);
        assert.strictEqual(2, removedItems.length);
        assert.deepStrictEqual(['Snake', 'Cyberhawk'], removedItems.map((player) => player.name));

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 1);
        assert.strictEqual("Jake", decodedState.arrayOfPlayers[0].name);
        assert.strictEqual(jake, decodedState.arrayOfPlayers[0]);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to insert elements with splice", () => {
        const state = new State();
        const p1 = new Player("Jake")
        const p2 = new Player("Snake")
        const p3 = new Player("Cyberhawk")
        const p4 = new Player("Katarina Lyons")

        const _ = getEncoder(state);

        state.arrayOfPlayers = new ArraySchema(p1, p2)
        state.arrayOfPlayers.splice(0, 2, p3, p4)

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Cyberhawk");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "Katarina Lyons");

        assertDeepStrictEqualEncodeAll(state);
    })

    it("should adjust the indexes of the elements after a splice", () => {
        const state = new State();
        const p1 = new Player("Jake");
        const p2 = new Player("Snake");
        const p3 = new Player("Cyberhawk");
        const p4 = new Player("Katarina Lyons");

        const newPlayer = new Player("John");

        state.arrayOfPlayers = new ArraySchema(p1, p2, p3, p4);
        state.arrayOfPlayers.splice(1, 2, newPlayer);

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Jake");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "John");
        assert.strictEqual(decodedState.arrayOfPlayers[2].name, "Katarina Lyons");

        const freshDecode = new State();
        freshDecode.decode(state.encodeAll());
        assert.strictEqual(freshDecode.arrayOfPlayers.length, 3);
        assert.strictEqual(freshDecode.arrayOfPlayers[0].name, "Jake");
        assert.strictEqual(freshDecode.arrayOfPlayers[1].name, "John");
        assert.strictEqual(freshDecode.arrayOfPlayers[2].name, "Katarina Lyons");

        assertDeepStrictEqualEncodeAll(state);
    })

    it("should allow to push and shift", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(
            new Player("Jake"),
            new Player("Snake"),
            new Player("Cyberhawk")
        );

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);

        //
        // PUSH & SHIFT (1st time)
        //
        // state.arrayOfPlayers[0].name = "XXX";
        state.arrayOfPlayers[1].name = "Snake Sanders";
        state.arrayOfPlayers.push(new Player("Katarina Lyons"));
        state.arrayOfPlayers.shift();

        assertDeepStrictEqualEncodeAll(state);

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Snake Sanders");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "Cyberhawk");
        assert.strictEqual(decodedState.arrayOfPlayers[2].name, "Katarina Lyons");

        //
        // PUSH & SHIFT (2nd time)
        //
        state.arrayOfPlayers.push(new Player("Jake Badlands"));
        state.arrayOfPlayers.shift();

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Cyberhawk");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "Katarina Lyons");
        assert.strictEqual(decodedState.arrayOfPlayers[2].name, "Jake Badlands");

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to shift and push", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema(
            new Player("Jake"),
            new Player("Snake"),
            new Player("Cyberhawk")
        );

        const decodedState = new State();
        decodedState.decode(state.encode());
        assert.strictEqual(decodedState.arrayOfPlayers.length, 3);

        // first `shift`, then `push`
        state.arrayOfPlayers.shift();
        state.arrayOfPlayers.shift();
        state.arrayOfPlayers.push(new Player("Katarina Lyons"));

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.arrayOfPlayers.length, 2);
        assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Cyberhawk");
        assert.strictEqual(decodedState.arrayOfPlayers[1].name, "Katarina Lyons");

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should trigger onAdd / onChange / onRemove", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 1));
        state.arrayOfPlayers.push(new Player("Three", 20, 2));

        const decodedState = new State();
        const $ = getCallbacks(decodedState);

        let onAddCount = 0;
        $(decodedState).arrayOfPlayers.onAdd(() => onAddCount++);

        let onRemoveCount = 0;
        $(decodedState).arrayOfPlayers.onRemove(() => onRemoveCount++);

        decodedState.decode(state.encode());
        assert.strictEqual(3, onAddCount);
        assert.strictEqual(0, onRemoveCount);

        state.arrayOfPlayers[0].x += 100;
        state.arrayOfPlayers.push(new Player("Four", 50, 3));
        state.arrayOfPlayers.push(new Player("Five", 40, 4));

        decodedState.decode(state.encode());

        assert.strictEqual(5, onAddCount);
        assert.strictEqual(0, onRemoveCount);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        decodedState.decode(state.encode());
        assert.strictEqual(2, onRemoveCount);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should support 'in' operator", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10, 0));
        state.arrayOfPlayers.push(new Player("Two", 30, 0));
        state.arrayOfPlayers.push(new Player("Three", 20, 0));

        assert.ok(0 in state.arrayOfPlayers === true);
        assert.ok(2 in state.arrayOfPlayers === true);
        assert.ok(3 in state.arrayOfPlayers === false);
        assert.ok(Symbol.iterator in state.arrayOfPlayers === true);
        assert.ok("length" in state.arrayOfPlayers === true);

        // decoded
        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());
        assert.ok(0 in decodedState.arrayOfPlayers === true);
        assert.ok(2 in decodedState.arrayOfPlayers === true);
        assert.ok(3 in decodedState.arrayOfPlayers === false);
        assert.ok(Symbol.iterator in decodedState.arrayOfPlayers === true);
        assert.ok("length" in decodedState.arrayOfPlayers === true);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to sort", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player().assign({ name: "One", x: 10, y: 0 }));
        state.arrayOfPlayers.push(new Player().assign({ name: "Two", x: 30, y: 1 }));
        state.arrayOfPlayers.push(new Player().assign({ name: "Three", x: 20, y: 2 }));
        state.arrayOfPlayers.push(new Player().assign({ name: "Four", x: 50, y: 3 }));
        state.arrayOfPlayers.push(new Player().assign({ name: "Five", x: 40, y: 4 }));

        const decodedState = new State();

        // decodedState.arrayOfPlayers.onAdd = function(item, i) {};
        // const onAddSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

        // decodedState.arrayOfPlayers.onChange = function(item, i) {};
        // const onChangeSpy = sinon.spy(decodedState.arrayOfPlayers, 'onChange');

        decodedState.decode(state.encode());
        // sinon.assert.callCount(onAddSpy, 5);
        // sinon.assert.callCount(onChangeSpy, 0);
        assert.deepStrictEqual(state.arrayOfPlayers.toArray(), decodedState.arrayOfPlayers.toArray());
        assert.deepStrictEqual(decodedState.arrayOfPlayers.map(p => p.name), ['One', 'Two', 'Three', 'Four', 'Five']);

        state.arrayOfPlayers.sort((a, b) => b.y - a.y);

        // assert.strictEqual(encoded.length, 23, "should encode only index changes");
        decodedState.decode(state.encode());

        assert.deepStrictEqual(state.arrayOfPlayers.toArray(), decodedState.arrayOfPlayers.toArray());
        assert.deepStrictEqual(decodedState.arrayOfPlayers.map(p => p.name), [ 'Five', 'Four', 'Three', 'Two', 'One' ]);
        // sinon.assert.callCount(onAddSpy, 5);
        // sinon.assert.callCount(onChangeSpy, 5);

        state.arrayOfPlayers.sort((a, b) => a.x - b.x);
        decodedState.decode(state.encode());
        // sinon.assert.callCount(onAddSpy, 5);
        // sinon.assert.callCount(onChangeSpy, 10);

        assert.deepStrictEqual(state.arrayOfPlayers.toArray(), decodedState.arrayOfPlayers.toArray());
        assert.deepStrictEqual(decodedState.arrayOfPlayers.map(p => p.name), ['One', 'Three', 'Two', 'Five', 'Four']);

        for (var a = 0; a < 100; a++) {
            for (var b = 0; b < state.arrayOfPlayers.length; b++) {
                var player = state.arrayOfPlayers[b];
                player.x = Math.floor(Math.random() * 100000);
            }

            state.arrayOfPlayers.sort((a, b) => b.x - a.x);
            decodedState.decode(state.encode());
            assert.deepStrictEqual(state.arrayOfPlayers.toArray(), decodedState.arrayOfPlayers.toArray());
            // sinon.assert.callCount(onAddSpy, 5);
        }

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow to filter and then sort", () => {
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

        assertDeepStrictEqualEncodeAll(state);
    });

    it("updates all items properties after removing middle item", () => {
        /**
         * In this scenario, after splicing middle item, I'm updating
         * each item's `idx` property, to reflect its current "index".
         * After remiving "Item 3", items 4 and 5 would get their
         * `idx` updated. Rest of properties should remain unchanged.
         */

        class Item extends Schema {
            @type("uint8") id: number = Math.round(Math.random() * 250);
            @type("uint8") idx: number;
            @type("string") name: string;
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

        state.player1.items.push(new Item().assign({ name: "Item 0", idx: 0 }));
        state.player1.items.push(new Item().assign({ name: "Item 1", idx: 1 }));
        state.player1.items.push(new Item().assign({ name: "Item 2", idx: 2 }));
        state.player1.items.push(new Item().assign({ name: "Item 3", idx: 3 }));
        state.player1.items.push(new Item().assign({ name: "Item 4", idx: 4 }));

        decodedState.decode(state.encodeAll());
        assert.strictEqual(decodedState.player1.items.length, 5);

        // Remove one item
        const [spliced] = state.player1.items.splice(2, 1);
        assert.strictEqual("Item 2", spliced.name);

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.player1.items.length, 4);

        // Update `idx` of each item
        state.player1.items.forEach((item, idx) => item.idx = idx);

        // After below encoding, Item 4 is not marked as `changed`
        decodedState.decode(state.encode());

        // Ensure all data is perserved and `idx` is updated for each item
        assert.deepStrictEqual(
            state.player1.items.toJSON(),
            decodedState.player1.items.toJSON(),
            `There's a difference between state and decoded state on some items`
        );

        const decodedState2 = new State();
        decodedState2.decode(state.encodeAll());

        // Ensure all data is perserved and `idx` is updated for each item
        assert.deepStrictEqual(
            state.player1.items.toJSON(),
            decodedState2.player1.items.toJSON(),
            `There's a difference between state and decoded state on some items`
        );

        assertDeepStrictEqualEncodeAll(state);
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
        assert.strictEqual(removedItem.name, "Item 2");
        decodedState.decode(state.encode());

        // Update `name` of remaining item
        const preEncoding = state.player.items[1].name = "Item 3 changed!";
        decodedState.decode(state.encode());

        assert.strictEqual(
            decodedState.player.items[1].name,
            preEncoding,
            `new name of Item 3 was not reflected during recent encoding/decoding.`
        );

        assertDeepStrictEqualEncodeAll(state);
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

        // console.log("CHANGES =>", util.inspect({
        //     $changes: state.items['$changes'],
        //     $items: state.items['$items'],
        // }, true, 3, true));

        state.items.forEach(updateItem);

        decodedState.decode(state.encode());

        assert.strictEqual(state.items[0].name, 'Item One');
        assert.strictEqual(state.items[1].name, 'Item Two');
        assert.strictEqual(state.items[2].name, 'Item Four');
        assert.strictEqual(state.items[3].name, 'Item Five');

        assert.deepStrictEqual(state.items.toJSON(), decodedState.items.toJSON());

        /**
         * Add the item back in
         */
        state.items.push(itemThree);
        state.items.forEach(updateItem);
        decodedState.decode(state.encode());

        assert.strictEqual(state.items[0].name, 'Item One');
        assert.strictEqual(state.items[1].name, 'Item Two');
        assert.strictEqual(state.items[2].name, 'Item Four');
        assert.strictEqual(state.items[3].name, 'Item Five');
        assert.strictEqual(state.items[4].name, 'Item Three');

        assertDeepStrictEqualEncodeAll(state);
    });

    it("multiple splices in one go", () => {
        class Item extends Schema {
            @type("string") name: string;
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

        state.player.items.push(new Item().assign({ name: "Item 1" }));
        state.player.items.push(new Item().assign({ name: "Item 2" }));
        state.player.items.push(new Item().assign({ name: "Item 3" }));

        console.log(Schema.debugChanges(state.player.items));

        decodedState.decode(state.encode());

        // ========================================

        // Remove Items 1 and 2 in two separate splice executions
        state.player.items.splice(0, 1);
        console.log(Schema.debugChanges(state.player.items));

        state.player.items.splice(0, 1);
        console.log(Schema.debugChanges(state.player.items));

        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.player.items.toJSON(), decodedState.player.items.toJSON());

        assert.strictEqual(decodedState.player.items.length, 1);
        assert.strictEqual(decodedState.player.items[0].name, `Item 3`);

        assertDeepStrictEqualEncodeAll(state);
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
        assert.strictEqual(state.player.items.length, 5);
        decodedState.decode(state.encodeAll());
        assert.strictEqual(decodedState.player.items.length, 5);
        // ========================================

        // Remove Item 1
        const [ removedItem1 ] = state.player.items.splice(0, 1);
        assert.strictEqual(removedItem1.name, "Item 1");
        assert.strictEqual(state.player.items.length, 4);

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.player.items.length, 4);

        const expectedA = [2, 3, 4, 5];
        decodedState.player.items.forEach((item, index) => {
            assert.strictEqual(item.name, `Item ${expectedA[index]}`);
        })
        // ========================================

        // Remove Items 2 and 3 in two separate splice executions
        const [ removedItem2 ] = state.player.items.splice(0, 1);
        const [ removedItem3 ] = state.player.items.splice(0, 1);

        assert.strictEqual(removedItem2.name, "Item 2");
        assert.strictEqual(removedItem3.name, "Item 3");
        assert.strictEqual(state.player.items.length, 2);

        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.player.items.length, 2);
        const expectedB = [4, 5];
        decodedState.player.items.forEach((item, index) => {
            assert.strictEqual(item.name, `Item ${expectedB[index]}`);
        })

        assertDeepStrictEqualEncodeAll(state);
    });

    xit("TODO: fix 'Decode warning: trying to remove refId that doesn't exist'", () => {
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
        decodedState.decode(state.encodeAll());

        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        // Remove Item 1
        state.player.items.splice(0, 1);
        decodedState.decode(state.encode());

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
        state.player.items.splice(0, 1);
        decodedState.decode(state.encode());

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        assertDeepStrictEqualEncodeAll(state);
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
        // decodedState.decode(state.encode());

        state.player1.items.push(new Item("Item 1"));
        state.player1.items.push(new Item("Item 2"));
        state.player1.items.push(new Item("Item 3"));
        state.player1.items.push(new Item("Item 4"));

        decodedState.decode(state.encode());

        const decodedItem0 = decodedState.player1.items[0];
        assert.strictEqual(decodedState.player1.items[0].name, "Item 1");
        assert.strictEqual(decodedState.player1.items[1].name, "Item 2");
        assert.strictEqual(decodedState.player1.items[2].name, "Item 3");
        assert.strictEqual(decodedState.player1.items[3].name, "Item 4");

        const item0 = state.player1.items[0];
        state.player1.items.splice(0, 1);
        state.player2.items.push(item0);

        const encoded = state.encode();
        decodedState.decode(encoded);

        assert.strictEqual(decodedState.player1.items.length, 3);
        assert.strictEqual(decodedState.player1.items[0].name, "Item 2");

        assert.strictEqual(decodedState.player2.items.length, 1);
        assert.strictEqual(decodedState.player2.items[0], decodedItem0, "should hold the same Item reference.");
        assert.strictEqual(decodedState.player2.items[0].name, "Item 1");

        state.player2.items.push(state.player1.items.splice(1, 1)[0]);
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.player1.items.length, 2);
        assert.strictEqual(decodedState.player2.items.length, 2);

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        assert.strictEqual(decodedState.player1.items.length, 1);
        assert.strictEqual(decodedState.player2.items.length, 3);

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        // console.log("FULL 1 >");
        // console.log(decodedState.player1.items.map(item => item.name));
        // console.log(decodedState.player2.items.map(item => item.name));
        assert.strictEqual(decodedState.player1.items.length, 0);
        assert.strictEqual(decodedState.player2.items.length, 4);
        assert.deepStrictEqual(decodedState.player2.items.map(item => item.name), ['Item 1', 'Item 3', 'Item 2', 'Item 4']);

        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player1.items.push(state.player2.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        // console.log("FULL 2 >");
        // console.log(decodedState.player1.items.map(item => item.name));
        // console.log(decodedState.player2.items.map(item => item.name));
        assert.deepStrictEqual(decodedState.player1.items.map(item => item.name), ['Item 1', 'Item 3', 'Item 2', 'Item 4']);
        assert.strictEqual(decodedState.player1.items.length, 4);
        assert.strictEqual(decodedState.player2.items.length, 0);

        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());
        state.player2.items.push(state.player1.items.splice(0, 1)[0]);
        decodedState.decode(state.encode());

        // console.log("FULL 3 >");
        // console.log(decodedState.player1.items.map(item => item.name));
        // console.log(decodedState.player2.items.map(item => item.name));
        assert.strictEqual(decodedState.player1.items.length, 0);
        assert.strictEqual(decodedState.player2.items.length, 4);
        assert.deepStrictEqual(decodedState.player2.items.map(item => item.name), ['Item 1', 'Item 3', 'Item 2', 'Item 4']);

        assertDeepStrictEqualEncodeAll(state);
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
        const removedItems = state.player.itemIds.splice(1, 1);
        assert.strictEqual(removedItems.length, 1);
        assert.strictEqual(removedItems[0], "Item 2");
        decodedState.decode(state.encode());

        // Update remaining item
        const preEncoding = state.player.itemIds[1] = "Item 3 changed!";
        decodedState.decode(state.encode());

        assert.strictEqual(4, decodedState.player.itemIds.length);

        assert.strictEqual(
            decodedState.player.itemIds[1],
            preEncoding,
            `new name of Item 3 was not reflected during recent encoding/decoding.`
        );

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow ArraySchema of repeated primitive values", () => {
        class State extends Schema {
            @type(["string"]) strings = new ArraySchema<string>();
            @type(["float64"]) floats = new ArraySchema<number>();
            @type(["number"]) numbers = new ArraySchema<number>();
        };

        const state = new State();
        state.numbers.push(1);
        state.floats.push(Math.PI);
        state.strings.push("one");

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepStrictEqual(["one"], decodedState.strings.toJSON());
        assert.deepStrictEqual([Math.PI], decodedState.floats.toJSON());
        assert.deepStrictEqual([1], decodedState.numbers.toJSON());

        state.numbers.push(1);
        state.floats.push(Math.PI);
        state.strings.push("one");
        decodedState.decode(state.encode());

        assert.deepStrictEqual(["one", "one"], decodedState.strings.toJSON());
        assert.deepStrictEqual([Math.PI, Math.PI], decodedState.floats.toJSON());
        assert.deepStrictEqual([1, 1], decodedState.numbers.toJSON());

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow sort unbound array", () => {
        const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
        assert.doesNotThrow(() => arr.sort());
    });

    it("should allow slice and sort unbound array", () => {
        const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
        assert.doesNotThrow(() => arr.slice(0).sort());
    });

    it("replacing ArraySchema should trigger onRemove on previous items", () => {
        class State extends Schema {
            @type(["number"]) numbers: ArraySchema<number>;
        }

        const state = new State();
        state.numbers = new ArraySchema(1, 2, 3, 4, 5, 6);

        const decodedState = new State();
        const $ = getCallbacks(decodedState);
        decodedState.decode(state.encode());

        let onRemoveCount = 0;
        $(decodedState).numbers.onRemove(() => onRemoveCount++)

        // state.numbers = undefined;
        state.numbers = new ArraySchema(7, 8, 9);
        decodedState.decode(state.encode());

        assert.strictEqual(6, onRemoveCount);

        const refCounts = getDecoder(decodedState).root.refCounts;
        assert.deepStrictEqual(refCounts, {
            0: 1,
            2: 1
        });

        assertDeepStrictEqualEncodeAll(state);
    });

    it("re-assignments should be ignored", () => {
        class State extends Schema {
            @type(["number"]) numbers = new ArraySchema<number>();
        }
        const state = new State();
        state.numbers[0] = 1;
        state.numbers[1] = 2;
        state.numbers[2] = 3;
        assert.ok(state.encode().length > 0);

        // re-assignments, should not be enqueued
        state.numbers[0] = 1;
        state.numbers[1] = 2;
        state.numbers[2] = 3;
        assert.ok(state.encode().length === 0);

        assertDeepStrictEqualEncodeAll(state);
    });

    describe("mixed operations along with sort", () => {
        class Card extends Schema {
            @type("uint16") id: number;
          }

        class MyState extends Schema {
            @type([Card]) cards = new ArraySchema<Card>();
        }

        function shuffle(array) {
            let currentIndex = array.length;

            // While there remain elements to shuffle...
            while (currentIndex != 0) {

                // Pick a remaining element...
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;

                // console.log(`[array[${currentIndex}], array[${randomIndex}]] = [array[${randomIndex}], array[${currentIndex}]];`);

                // And swap it with the current element.
                [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
            }
        }

        it("should push and move entries", () => {
            const state = new MyState();
            state.cards.push(new Card().assign({ id: 2 }));
            state.cards.push(new Card().assign({ id: 3 }));
            state.cards.push(new Card().assign({ id: 4 }));
            state.cards.push(new Card().assign({ id: 5 }));

            const decodedState = new MyState();
            decodedState.decode(state.encode());

            state.cards.push(new Card().assign({ id: 6 }));

            [state.cards[4], state.cards[3]] = [state.cards[3], state.cards[4]];
            [state.cards[3], state.cards[2]] = [state.cards[2], state.cards[3]];
            [state.cards[2], state.cards[0]] = [state.cards[0], state.cards[2]];
            [state.cards[1], state.cards[1]] = [state.cards[1], state.cards[1]];
            [state.cards[0], state.cards[0]] = [state.cards[0], state.cards[0]];

            decodedState.decode(state.encode());

            assert.deepStrictEqual(state.cards.toJSON(), decodedState.cards.toJSON());
            assert.strictEqual(state.cards.length, decodedState.cards.length);

            const $root = getDecoder(decodedState).root;
            const refCounts = $root.refCounts;

            assert.strictEqual($root.refs.size, 7, "should have 7 refs");
            assert.strictEqual(refCounts[0], 1, JSON.stringify($root.refs.get(0).toJSON()));
            assert.strictEqual(refCounts[1], 1, JSON.stringify($root.refs.get(1).toJSON()));
            assert.strictEqual(refCounts[2], 1, JSON.stringify($root.refs.get(2).toJSON()));
            assert.strictEqual(refCounts[3], 1, JSON.stringify($root.refs.get(3).toJSON()));
            assert.strictEqual(refCounts[4], 1, JSON.stringify($root.refs.get(4).toJSON()));
            assert.strictEqual(refCounts[5], 1, JSON.stringify($root.refs.get(5).toJSON()));
            assert.strictEqual(refCounts[6], 1, JSON.stringify($root.refs.get(6).toJSON()));

            assertDeepStrictEqualEncodeAll(state);
        });

        it("should pop and shuffle", () => {
            const state = new MyState();

            state.cards.push(new Card().assign({ id: 1 }));
            state.cards.push(new Card().assign({ id: 2 }));
            state.cards.push(new Card().assign({ id: 3 }));
            state.cards.push(new Card().assign({ id: 4 }));

            const decodedState = new MyState();
            decodedState.decode(state.encode());

            state.cards.pop();
            shuffle(state.cards);

            decodedState.decode(state.encode());
            assert.deepStrictEqual(
                decodedState.cards.map(c => c.id).sort(),
                [1, 2, 3]
            );

            assertDeepStrictEqualEncodeAll(state);
        });

        it("should splice and move", () => {
            const state = new MyState();

            state.cards.push(new Card().assign({ id: 2 }));
            state.cards.push(new Card().assign({ id: 3 }));
            state.cards.push(new Card().assign({ id: 4 }));
            state.cards.push(new Card().assign({ id: 5 }));

            const decodedState = new MyState();
            const $ = getCallbacks(decodedState);

            let onAddIds: number[] = [];
            let onRemoveIds: number[] = [];
            $(decodedState).cards.onAdd((item, i) => onAddIds.push(item.id));
            $(decodedState).cards.onRemove((item, i) => onRemoveIds.push(item.id));

            decodedState.decode(state.encode());

            state.cards.splice(2, 1);
            [state.cards[2], state.cards[0]] = [state.cards[0], state.cards[2]];

            const encoded = state.encode();
            assert.strictEqual(8, encoded.length);

            decodedState.decode(encoded);

            assert.deepStrictEqual(onAddIds, [2, 3, 4, 5]);
            assert.deepStrictEqual(onRemoveIds, [4]);

            const refCounts = getDecoder(decodedState).root.refCounts;
            assert.deepStrictEqual(refCounts, {
                0: 1,
                1: 1,
                2: 1,
                3: 1,
                5: 1
            });

            assert.deepStrictEqual(
                decodedState.cards.map(c => c.id).sort(),
                [2, 3, 5]
            );

            assertDeepStrictEqualEncodeAll(state);
        });

        it("should splice and shuffle", () => {
            const state = new MyState();

            state.cards.push(new Card().assign({ id: 2 }));
            state.cards.push(new Card().assign({ id: 3 }));
            state.cards.push(new Card().assign({ id: 4 }));
            state.cards.push(new Card().assign({ id: 5 }));

            const decodedState = new MyState();
            decodedState.decode(state.encode());

            state.cards.splice(2, 1);

            [state.cards[2], state.cards[0]] = [state.cards[0], state.cards[2]];
            [state.cards[1], state.cards[0]] = [state.cards[0], state.cards[1]];
            [state.cards[0], state.cards[0]] = [state.cards[0], state.cards[0]];

            decodedState.decode(state.encode());

            const refCounts = getDecoder(decodedState).root.refCounts;
            assert.deepStrictEqual(refCounts, {
                0: 1,
                1: 1,
                2: 1,
                3: 1,
                5: 1
            });

            assert.deepStrictEqual(
                decodedState.cards.map(c => c.id).sort(),
                [2, 3, 5]
            );
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("#clear", () => {
        class Point extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class State extends Schema {
            @type([Point]) points = new ArraySchema<Point>();
        }

        it("should have 0 entries after clear", () => {
            const state = new State();
            state.points.push(
                new Point().assign({ x: 0, y: 0 }),
                new Point().assign({ x: 1, y: 1 }),
                new Point().assign({ x: 2, y: 2 }),
            );

            const decodedState = new State();
            let encoded = state.encodeAll();
            decodedState.decode(encoded);
            assert.strictEqual(3, decodedState.points.length);

            state.points.clear();

            encoded = state.encode();
            decodedState.decode(encoded);
            assert.strictEqual(0, decodedState.points.length);

            const decodedState2 = new State();

            encoded = state.encodeAll();
            decodedState2.decode(encoded);
            assert.strictEqual(0, decodedState2.points.length);

            assertDeepStrictEqualEncodeAll(state);

            const refCounts = getDecoder(decodedState).root.refCounts;
            assert.deepStrictEqual(refCounts, {
                0: 1,
                1: 1,
            });
        });

        xit("should trigger onAdd callback only once after clearing and adding one item", () => {
            const state = new State();
            const decodedState = new State();
            const $ = getCallbacks(decodedState);

            state.points.push(new Point().assign({ x: 0, y: 0 }));
            state.points.push(new Point().assign({ x: 1, y: 1 }));
            state.points.clear();
            state.points.push(new Point().assign({ x: 2, y: 2 }));
            state.points.push(new Point().assign({ x: 3, y: 3 }));

            let onAddCallCount = 0;
            $(decodedState).points.onAdd((point, key) => {
                onAddCallCount++;
                console.log(point.toJSON(), key);
            });

            decodedState.decode(state.encodeAll());
            decodedState.decode(state.encode());

            assert.deepStrictEqual([
                { x: 2, y: 2 },
                { x: 3, y: 3 }
            ], decodedState.points.toJSON());

            assert.strictEqual(2, onAddCallCount);

            assertDeepStrictEqualEncodeAll(state);
        });
    })

    describe("array methods", () => {
        it("#find()", () => {
            const arr = new ArraySchema<number>(1,2,3,4,5);
            assert.strictEqual(3, arr.find((v) => v === 3));
        });

        it("#concat()", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            const concat = arr.concat([4, 5, 6]);
            assert.deepStrictEqual([1, 2, 3, 4, 5, 6], concat.toJSON());
        });

        it("#join()", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            assert.strictEqual("1,2,3", arr.join(","));
        });

        it("#indexOf()", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            assert.strictEqual(1, arr.indexOf(2));
        });

        it("#lastIndexOf()", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 1, 2, 3);
            assert.strictEqual(4, arr.lastIndexOf(2));
        });

        it("#reverse()", () => {
            class State extends Schema {
                @type(["number"]) numbers = new ArraySchema<number>();
            }

            const state = new State();
            state.numbers =  new ArraySchema<number>(1, 2, 3, 4, 5);

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            state.numbers.reverse();
            assert.deepStrictEqual([5, 4, 3, 2, 1], state.numbers.toJSON());

            decodedState.decode(state.encode());
            assert.deepStrictEqual([5, 4, 3, 2, 1], decodedState.numbers.toJSON());
        });

        it("#flat", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            assert.throws(() => { arr.flat(); }, /not supported/i);
        })

        it("#flatMap", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            assert.throws(() => { arr.flatMap(() => {}); }, /not supported/i);
        });

        it(".length = 0", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            arr.length = 0;

            assert.deepStrictEqual([], arr.toJSON());
        });

        it(".length = x", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            arr.length = 3;

            assert.deepStrictEqual([1,2,3], arr.toJSON());
        });

        it("#at()", () => {
            const arr = new ArraySchema<number>(1,2,3,4,5);
            assert.strictEqual(1, arr.at(0));
            assert.strictEqual(3, arr.at(2));
            assert.strictEqual(5, arr.at(-1));
            assert.strictEqual(1, arr.at(-5));
            assert.strictEqual(undefined, arr.at(5));
            assert.strictEqual(undefined, arr.at(-6));
        });

        it("#with()", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            assert.deepStrictEqual([1, 6, 3, 4, 5], arr.with(1, 6).toJSON());
            assert.deepStrictEqual([1, 2, 3, 4, 7], arr.with(-1, 7).toJSON());
            assert.deepStrictEqual([1, 2, 3, 8, 5], arr.with(-2, 8).toJSON());
        });

        it(".from()", () => {
            const numbers = [1,2,3,4,5];
            assert.deepStrictEqual(numbers, ArraySchema.from(numbers).toJSON());

            const strings = ["one", "two", "three"];
            assert.deepStrictEqual(strings, ArraySchema.from(strings).toJSON());

            const map = new Map();
            map.set("one", 1);
            map.set("two", 2);

            assert.deepStrictEqual(Array.from(map.values()), ArraySchema.from(map.values()).toJSON());
        });
    });

    describe("ArraySchema <-> Array type interchangability", () => {
        it("should allow assigning array to an ArraySchema", () => {
            class State extends Schema {
                @type(["number"]) numbers: number[] = new ArraySchema<number>();
            }

            const state = new State();
            state.numbers = [1, 2, 3, 4, 5];

            const decodedState = new State();
            decodedState.decode(state.encode());
            assert.deepStrictEqual([1, 2, 3, 4, 5], Array.from(decodedState.numbers));

            assertDeepStrictEqualEncodeAll(state);
        });

    });

    describe("Edge cases", () => {
        it("set values by index, sort, and then get values by index", () => {
            const arr = new ArraySchema<number>();
            arr[0] = 100;
            arr[1] = 50;

            const copy = arr.slice(0).sort((a, b) => a - b);
            assert.strictEqual(50, copy[0]);
            assert.strictEqual(100, copy[1]);
        });
    });

});
