import { State } from "./Schema";
import { ReflectionSchema } from "../src/annotations";

describe("Reflection", () => {

    it("should encode schema definitions", () => {
        const state = new State();

        const reflected = new ReflectionSchema();
        reflected.decode(state.encodeSchema());

        console.log(JSON.stringify(reflected));
    });

});