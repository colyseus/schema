import * as msgpack from "notepack.io";
import * as assert from "assert";
import { State, Player } from '../example/State';
import { Sync, sync } from "../src/annotations";

describe("State", () => {
    describe("declaration", () => {
        it("should allow to define default values", () => {
            class DataObject extends Sync {
                @sync("string")
                stringValue = "initial value";
            }

            let data = new DataObject();
            assert.equal(data.stringValue, "initial value");
            assert.deepEqual((DataObject as any)._schema, { stringValue: 'string' });
        });
    });

    describe("patching", () => {
        it("should encode changed values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;

            state.player = new Player();
            state.player.name = "Jake Badlands";
            state.player.x = 50;
            state.player.y = 50;

            const serialized = state.encode();
            const newState = new State();
            // newState.onChange = function(field, value, previousValue) {
            //     console.log(field, "HAS CHANGED FROM", previousValue, "TO", value);
            // }
            newState.decode(serialized);

            assert.equal(newState.fieldString, "Hello world!");
            assert.equal(newState.fieldNumber, 50);

            assert.ok(newState.player instanceof Player);
            assert.equal(newState.player.name, "Jake Badlands");
            assert.equal(newState.player.x, 50);
            assert.equal(newState.player.y, 50);
        });
    });

    // describe("Encoding", () => {
    // });
});
