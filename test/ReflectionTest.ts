import { State } from "./Schema";
import { Reflection } from "../src/annotations";

describe("Reflection", () => {

    it("should encode schema definitions", () => {
        const state = new State();

        const reflected = new Reflection();
        reflected.decode(state.encodeSchema());

        console.log(JSON.stringify(reflected));
    });

});