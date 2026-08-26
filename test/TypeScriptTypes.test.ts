import * as assert from "assert";
import "./Schema"; // installs the encode/decode test helpers on Schema.prototype
import { Schema, MapSchema, type } from "../src";

// Compile-time behaviour lives in test/types/ — tsx strips types without
// checking them, so type assertions in a .test.ts file enforce nothing.
describe("TypeScript Types", () => {
    it("encodes a number field assigned null", () => {
        class Player extends Schema {
            @type("number") orderPriority: number;
        }
        class MyState extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new MyState();
        state.players.set("one", new Player().assign({ orderPriority: null }));

        assert.doesNotThrow(() => state.encodeAll());
    });
});
