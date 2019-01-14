import * as assert from "assert";
import { Sync, sync } from "../src/annotations";
import { State, Player } from "./Schema";

describe("State API", () => {

    describe("declaration", () => {
        it("default values", () => {
            class DataObject extends Sync {
                @sync("string")
                stringValue = "initial value";

                @sync("number")
                intValue = 300;
            }

            let data = new DataObject();
            assert.equal(data.stringValue, "initial value");
            assert.equal(data.intValue, 300);
            assert.deepEqual((DataObject as any)._schema, {
                stringValue: 'string',
                intValue: 'number',
            });
            assert.deepEqual(data.encode(), [0, 173, 105, 110, 105, 116, 105, 97, 108, 32, 118, 97, 108, 117, 101, 1, 205, 300, 1]);
        });

        it("uint8", () => {
            class Data extends Sync { @sync("uint8") uint8 = 255; }

            let data = new Data();
            assert.equal(data.uint8, 255);

            data.uint8 = 127;
            let encoded = data.encode();

            assert.deepEqual(encoded, [0, 127]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.uint8, 127);
        });

        it("uint16", () => {
            class Data extends Sync { @sync("uint16") uint16; }

            let data = new Data();
            data.uint16 = 65500;

            let encoded = data.encode();
            console.log(encoded);
            assert.deepEqual(encoded, [ 0, 65500, 255 ]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.uint16, 65500);
        });

        it("uint32", () => {
            class Data extends Sync { @sync("uint32") uint32; }

            let data = new Data();
            data.uint32 = 4294967290;

            let encoded = data.encode();
            console.log(encoded);
            assert.deepEqual(encoded, [0, 4294967290, -1, -1, -1]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.uint32, 4294967290);
        });

        it("int8", () => {
            class Data extends Sync { @sync("int8") int8; }

            let data = new Data();
            data.int8 = -128;

            let encoded = data.encode();
            assert.deepEqual(encoded, [0, -128]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.int8, -128);
        });

        it("int16", () => {
            class Data extends Sync { @sync("int16") int16; }

            let data = new Data();
            data.int16 = -32768;

            let encoded = data.encode();
            // assert.deepEqual(encoded, []);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.int16, -32768);
        });

        it("int32", () => {
            class Data extends Sync { @sync("int32") int32; }

            let data = new Data();
            data.int32 = -2147483648;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 4294967290, -1, -1, -1]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.equal(decoded.int32, -2147483648);
        });

    });

    describe("encoding/decoding", () => {
        it("should encode/decode STRING", () => {
            const state = new State();
            state.fieldString = "Hello world";

            let encoded = state.encode();
            assert.deepEqual(encoded, [0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100]);

            const decodedState = new State();
            decodedState.decode(encoded);

            assert.equal(decodedState.fieldString, "Hello world");
        });

        it("should encode/decode INT", () => {
            const state = new State();
            state.fieldNumber = 50;

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.equal(decodedState.fieldNumber, 50);

            state.fieldNumber = 100;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 100);

            state.fieldNumber = 300;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 300);

            state.fieldNumber = 500;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 500);

            state.fieldNumber = 1000;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 1000);

            state.fieldNumber = 2000;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 2000);

            state.fieldNumber = 999999;
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 999999);
        });

        it("should encode/decode empty Sync reference", () => {
            const state = new State();
            state.player = new Player();

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            assert.deepEqual(encoded, [2]);
            assert.ok(decodedState.player instanceof Player);
        });

        it("should encode/decode Sync reference with its properties", () => {
            const state = new State();
            state.player = new Player();
            state.player.name = "Jake";
            state.player.x = 100;
            state.player.y = 200;

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            assert.deepEqual(encoded, [2, 0, 164, 74, 97, 107, 101, 1, 100, 2, 204, 200, 193]);
            assert.ok(decodedState.player instanceof Player);
            assert.equal(decodedState.player.x, 100);
            assert.equal(decodedState.player.y, 200);
        });

        it("should re-use child Sync instance when decoding multiple times", () => {
            const state = new State();
            state.player = new Player();
            state.player.name = "Guest";

            const decodedState = new State();
            decodedState.decode(state.encode());

            const playerReference = decodedState.player;
            assert.ok(playerReference instanceof Player);
            assert.equal(playerReference.name, "Guest");

            state.player.name = "Jake";
            decodedState.decode(state.encode());
            assert.equal(decodedState.player, playerReference);
            assert.equal(playerReference.name, "Jake");
        });

        it("should encode empty array", () => {
            const state = new State();
            state.arrayOfPlayers = [];

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            assert.deepEqual(encoded, [3, 0, 0]);
            assert.deepEqual(decodedState.arrayOfPlayers, []);
        });

        it("should encode array with two values", () => {
            const state = new State();
            state.arrayOfPlayers = [
                new Player("Jake Badlands"),
                new Player("Snake Sanders"),
            ];

            const decodedState = new State();
            const encoded = state.encode();
            assert.deepEqual(encoded, [3, 2, 2, 0, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 1, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193]);

            decodedState.decode(encoded);

            const decodedPlayer1 = decodedState.arrayOfPlayers[0];
            const decodedPlayer2 = decodedState.arrayOfPlayers[1];
            assert.equal(decodedState.arrayOfPlayers.length, 2);
            assert.equal(decodedPlayer1.name, "Jake Badlands");
            assert.equal(decodedPlayer2.name, "Snake Sanders");

            state.arrayOfPlayers.push(new Player("Tarquinn"));
            decodedState.decode(state.encode());

            assert.equal(decodedState.arrayOfPlayers.length, 3);
            assert.equal(decodedState.arrayOfPlayers[0], decodedPlayer1);
            assert.equal(decodedState.arrayOfPlayers[1], decodedPlayer2);
            assert.equal(decodedState.arrayOfPlayers[2].name, "Tarquinn");

            state.arrayOfPlayers.pop();
            state.arrayOfPlayers[0].name = "Tarquinn"
            decodedState.decode(state.encode());

            assert.equal(decodedState.arrayOfPlayers.length, 2);
            assert.equal(decodedState.arrayOfPlayers[0], decodedPlayer1);
            assert.equal(decodedState.arrayOfPlayers[0].name, "Tarquinn");
            assert.equal(decodedState.arrayOfPlayers[1], decodedPlayer2);
            assert.equal(decodedState.arrayOfPlayers[2], undefined);
        });

        it("should encode map of objects", () => {
            const state = new State();
            state.mapOfPlayers = {
                "one": new Player("Jake Badlands"),
                "two": new Player("Snake Sanders")
            };

            let encoded = state.encode();
            assert.deepEqual(encoded, [4, 2, 163, 111, 110, 101, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 163, 116, 119, 111, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193]);

            const decodedState = new State();
            decodedState.decode(encoded);

            const playerOne = decodedState.mapOfPlayers.one;
            const playerTwo = decodedState.mapOfPlayers.two;

            assert.deepEqual(Object.keys(decodedState.mapOfPlayers), ["one", "two"]);
            assert.equal(playerOne.name, "Jake Badlands");
            assert.equal(playerTwo.name, "Snake Sanders");

            state.mapOfPlayers.one.name = "Tarquinn";

            encoded = state.encode();
            assert.deepEqual(encoded, [4, 1, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193]);

            decodedState.decode(encoded);

            assert.equal(playerOne, decodedState.mapOfPlayers.one);
            assert.equal(decodedState.mapOfPlayers.one.name, "Tarquinn");
        });

        xit("should allow adding and removing items from map", () => {
            const state = new State();
            state.mapOfPlayers = {}

            state.mapOfPlayers['one'] = new Player("Jake Badlands");
            state.mapOfPlayers['two'] = new Player("Snake Sanders");

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.deepEqual(Object.keys(decodedState.mapOfPlayers), ["one", "two"]);
            assert.equal(decodedState.mapOfPlayers.one.name, "Jake Badlands");
            assert.equal(decodedState.mapOfPlayers.two.name, "Snake Sanders");

            delete state.mapOfPlayers['two'];
            decodedState.decode(state.encode());
            assert.deepEqual(Object.keys(decodedState.mapOfPlayers), ["one"]);
        });

        it("should encode changed values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;

            state.player = new Player();
            state.player.name = "Jake Badlands";
            state.player.y = 50;

            const encoded = state.encode();
            assert.deepEqual(encoded, [0, 172, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33, 1, 50, 2, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 2, 50, 193]);

            // SHOULD PRESERVE VALUES AFTER SERIALIZING
            assert.equal(state.fieldString, "Hello world!");
            assert.equal(state.fieldNumber, 50);
            assert.ok(state.player instanceof Player);
            assert.equal((state.player as any).$parent, state);
            assert.equal(state.player.name, "Jake Badlands");
            assert.equal(state.player.x, undefined);
            assert.equal(state.player.y, 50);

            const decodedState = new State();
            decodedState.decode(encoded);

            const decodedPlayerReference = decodedState.player;

            assert.equal(decodedState.fieldString, "Hello world!");
            assert.equal(decodedState.fieldNumber, 50);

            assert.ok(decodedPlayerReference instanceof Player);
            assert.equal(decodedState.player.name, "Jake Badlands");
            assert.equal(decodedState.player.x, undefined, "unset variable should be undefined");
            assert.equal(decodedState.player.y, 50);

            /**
             * Lets encode a single change now
             */

            // are Player and State unchanged?
            assert.equal((state.player as any).$changed, false);
            assert.equal((state as any).$changed, false);

            state.player.x = 30;

            // Player and State should've changes!
            assert.equal((state.player as any).$changed, true);
            assert.equal((state as any).$changed, true);

            const serializedChanges = state.encode();

            decodedState.decode(serializedChanges);
            assert.equal(decodedPlayerReference, decodedState.player, "should re-use the same Player instance");
            assert.equal(decodedState.player.name, "Jake Badlands");
            assert.equal(decodedState.player.x, 30);
            assert.equal(decodedState.player.y, 50);
        });

        it("should support array of strings", () => {
            class MyState extends Sync {
                @sync(["string"])
                arrayOfStrings: string[];
            }

            const state = new MyState();
            state.arrayOfStrings = ["one", "two", "three"];

            let encoded = state.encode();
            assert.deepEqual(encoded, [0, 3, 3, 0, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101]);

            const decodedState = new MyState();
            decodedState.decode(encoded);

            assert.deepEqual(decodedState.arrayOfStrings, ["one", "two", "three"]);
        });

        it("should support array of numbers", () => {
            class MyState extends Sync {
                @sync(["number"])
                arrayOfNumbers: number[];
            }

            const state = new MyState();
            state.arrayOfNumbers = [144, 233, 377, 610, 987, 1597, 2584];

            let encoded = state.encode();
            assert.deepEqual(encoded, [0, 7, 7, 0, 204, 144, 1, 204, 233, 2, 205, 377, 1, 3, 205, 610, 2, 4, 205, 987, 3, 5, 205, 1597, 6, 6, 205, 2584, 10]);

            const decodedState = new MyState();
            decodedState.decode(encoded);

            assert.deepEqual(decodedState.arrayOfNumbers, [144, 233, 377, 610, 987, 1597, 2584]);
        });

        it("no changes", () => {
            const state = new State();
            assert.deepEqual(state.encode(), []);

            const decodedState = new State();
            assert.doesNotThrow(() => decodedState.decode(state.encode()));

            state.arrayOfPlayers = [];
            state.mapOfPlayers = {};
            assert.doesNotThrow(() => decodedState.decode(state.encode()));
        });
    });
});
