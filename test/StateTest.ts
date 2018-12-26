import * as msgpack from "notepack.io";
import * as assert from "assert";
import { State, Player } from '../example/State';

describe("State", () => {
    // describe("data types", () => {
    //     it("string", () => {
    //         const state = new State();
    //         state.fieldString = "Hello world!";
    //         // assert.deepEqual(state.encode(), [ 172, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33 ]);
    //     })

    //     it("int", () => {
    //         const state = new State();
    //         state.fieldNumber = 5;
    //         assert.equal(state.fieldNumber, 5);

    //         state.fieldNumber += 1;
    //         assert.equal(state.fieldNumber, 6);
    //     });

    //     it("float", () => {
    //         const state = new State();
    //         state.fieldNumber = 42.22;
    //         assert.equal(state.fieldNumber, 42.22);
    //     });
    // });

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
