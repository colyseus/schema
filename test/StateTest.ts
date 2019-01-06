import * as assert from "assert";
import { State, Player } from '../example/State';
import { Sync, sync } from "../src/annotations";

describe("State API", () => {

    describe("declaration", () => {
        it("should allow to define default values", () => {
            class DataObject extends Sync {
                @sync("string")
                stringValue = "initial value";

                @sync("int")
                intValue = 50;
            }

            let data = new DataObject();
            assert.equal(data.stringValue, "initial value");
            assert.equal(data.intValue, 50);
            assert.deepEqual((DataObject as any)._schema, {
                stringValue: 'string',
                intValue: 'int',
            });
        });
    });

    describe("encoding/decoding", () => {
        it("should encode/decode STRING", () => {
            const state = new State();
            state.fieldString = "Hello world";

            const decodedState = new State();
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldString, "Hello world");
        });

        it("should encode/decode INT", () => {
            const state = new State();
            state.fieldNumber = 50;

            const decodedState = new State();
            decodedState.decode(state.encode());
            assert.equal(decodedState.fieldNumber, 50);
        });

        it("should encode/decode empty Sync reference", () => {
            const state = new State();
            state.player = new Player();

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.ok(decodedState.player instanceof Player);
        });

        it("should encode/decode Sync reference with its properties", () => {
            const state = new State();
            state.player = new Player();
            state.player.name = "Jake";
            state.player.x = 100;
            state.player.y = 200;

            const decodedState = new State();
            decodedState.decode(state.encode());

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
            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfPlayers, []);
        });

        it("should encode array with two values", () => {
            const state = new State();
            state.arrayOfPlayers = [
                new Player("Jake Badlands"),
                new Player("Snake Sanders"),
            ];

            const decodedState = new State();
            decodedState.decode(state.encode());

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

            const decodedState = new State();
            decodedState.decode(state.encode());

            const playerOne = decodedState.mapOfPlayers.one;
            const playerTwo = decodedState.mapOfPlayers.two;

            assert.deepEqual(Object.keys(decodedState.mapOfPlayers), ["one", "two"]);
            assert.equal(playerOne.name, "Jake Badlands");
            assert.equal(playerTwo.name, "Snake Sanders");

            state.mapOfPlayers.one.name = "Tarquinn";
            decodedState.decode(state.encode());

            assert.equal(playerOne, decodedState.mapOfPlayers.one);
            assert.equal(decodedState.mapOfPlayers.one.name, "Tarquinn");
        });

        it("should encode changed values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;

            state.player = new Player();
            state.player.name = "Jake Badlands";
            state.player.y = 50;

            const serialized = state.encode();

            // SHOULD PRESERVE VALUES AFTER SERIALIZING
            assert.equal(state.fieldString, "Hello world!");
            assert.equal(state.fieldNumber, 50);
            assert.ok(state.player instanceof Player);
            assert.equal((state.player as any)._parent, state);
            assert.equal(state.player.name, "Jake Badlands");
            assert.equal(state.player.x, undefined);
            assert.equal(state.player.y, 50);

            const newState = new State();
            newState.decode(serialized);

            const decodedPlayerReference = newState.player;

            assert.equal(newState.fieldString, "Hello world!");
            assert.equal(newState.fieldNumber, 50);

            assert.ok(decodedPlayerReference instanceof Player);
            assert.equal(newState.player.name, "Jake Badlands");
            assert.equal(newState.player.x, undefined, "unset variable should be undefined");
            assert.equal(newState.player.y, 50);

            /**
             * Lets encode a single change now
             */

            // are Player and State unchanged?
            assert.equal((state.player as any)._changed, false);
            assert.equal((state as any)._changed, false);

            state.player.x = 30;

            // Player and State should've changes!
            assert.equal((state.player as any)._changed, true);
            assert.equal((state as any)._changed, true);

            const serializedChanges = state.encode();

            newState.decode(serializedChanges);
            assert.equal(decodedPlayerReference, newState.player, "should re-use the same Player instance");
            assert.equal(newState.player.name, "Jake Badlands");
            assert.equal(newState.player.x, 30);
            assert.equal(newState.player.y, 50);
        });
    });
});
