import * as assert from "assert";
import { State } from './../src/State';

describe("State", () => {
    // describe("Getters", () => {
    //     it("should get a numeric value", () => {
    //         assert.ok(true);
    //     });
    // });

    describe("data types", () => {
        it("string", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            assert.equal(state.fieldString, "Hello world!");
        })

        it("int", () => {
            const state = new State();
            state.fieldNumber = 5;
            assert.equal(state.fieldNumber, 5);

            state.fieldNumber += 1;
            assert.equal(state.fieldNumber, 6);
        });

        it("float", () => {
            const state = new State();
            state.fieldNumber = 42.22;
            assert.equal(state.fieldNumber, 42.22);
        });
    });

    describe("patching", () => {
        it("should encode changed values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;
            console.log(state.serialize());
        });
    });

    // describe("Encoding", () => {
    // });
});
