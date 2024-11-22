import * as assert from "assert";
import { Schema, type, Reflection } from "../src";
import { getEncoder } from "./Schema";

describe("Community cases", () => {

    it("colyseus/schema/issues/143", () => {
        class OptionalChildSchema extends Schema {
            @type('number')  index: number = 200;
            @type('string')  my_string: string = 'a good string';
        }

        class Test extends Schema {
            @type('number') size: number = 0; // total number of storage slots in this container.
            @type('boolean') transient?: boolean;
            @type(OptionalChildSchema) sub?: OptionalChildSchema;
        }

        const state = new Test();
        const encoded = state.encodeAll();
        const handshake = Reflection.encode(getEncoder(state));

        const decodedState = Reflection.decode<Test>(handshake).state;
        assert.strictEqual(decodedState.sub, undefined);

        decodedState.decode(encoded);
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        state.sub = new OptionalChildSchema();
        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
    });

});
