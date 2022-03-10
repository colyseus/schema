import * as assert from "assert";
import { Schema, type, LifoSchema } from "../src";

describe("LifoSchema Tests", () => {

    it("should shift and push", () => {

        class State extends Schema {
            @type(["number"]) numbers: LifoSchema<number>;
        }

        const state = new State();
        state.numbers = new LifoSchema<number>(5);
        for (let i = 0; i < 10; i++) {
            state.numbers.push(i);
        }

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.numbers.map(n => n), [5, 6, 7, 8, 9]);
        assert.strictEqual(decodedState.numbers.length, 5);
    });
});