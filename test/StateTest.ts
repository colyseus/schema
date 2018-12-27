import * as assert from "assert";
import { State, Player } from '../example/State';
import { Sync, sync } from "../src/annotations";

describe("State", () => {

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

    describe("encoding", () => {
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

            console.log("LETS ENCODE AGAIN");
            const serializedChanges = state.encode();
            console.log(serializedChanges.length, serializedChanges);

            console.log("LETS DECODE AGAIN");

            newState.decode(serializedChanges);
            assert.equal(decodedPlayerReference, newState.player, "should re-use the same Player instance");
            assert.equal(newState.player.x, 50);
        });
    });
});
