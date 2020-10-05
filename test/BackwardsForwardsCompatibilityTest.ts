import * as assert from "assert";
import { Reflection, type, Schema, MapSchema, ArraySchema } from "../src";
import { deprecated } from "../src/annotations";

describe("backwards/forwards compatibility", () => {

    class PlayerV1 extends Schema {
        @type("number") x: number = Math.random();
        @type("number") y: number = Math.random();
    }

    class StateV1 extends Schema {
        @type("string") str: string;
        @type({ map: PlayerV1 }) map = new MapSchema<PlayerV1>();
        @type("string") currentTurn: string;
    }

    class PlayerV2 extends Schema {
        @type("number") x: number = Math.random();
        @type("number") y: number = Math.random();
        @type("string") name = "Jake Badlands";
        @type(["string"]) arrayOfStrings = new ArraySchema<string>("one", "two", "three");
    }

    class StateV2 extends Schema {
        @type("string") str: string;
        @type({ map: PlayerV2 }) map = new MapSchema<PlayerV2>();
        @deprecated() @type("string") currentTurn: string;
        @type("number") countdown: number;
    }

    it("should be backward compatible", () => {
        const state = new StateV1();
        state.str = "Hello world";
        state.map['one'] = new PlayerV1();

        const decodedStateV2 = new StateV2();
        decodedStateV2.decode(state.encode());
        assert.strictEqual("Hello world", decodedStateV2.str);
        // assert.strictEqual(10, decodedStateV2.countdown);

        assert.throws(() => {
            return decodedStateV2.currentTurn;
        }, "should throw an error trying to get deprecated attribute");
    });

    it("should be forward compatible", () => {
        const state = new StateV2();
        state.str = "Hello world";
        state.countdown = 10;

        state.map.set("p", new PlayerV2().assign({
            x: 10,
            y: 10,
            name: "Forward",
            arrayOfStrings: new ArraySchema("one"),
        }));

        const encoded = state.encode();

        const decodedStateV1 = new StateV1();
        decodedStateV1.decode(encoded);
        assert.strictEqual("Hello world", decodedStateV1.str);
    });

    it("should allow reflection", () => {
        const state = new StateV2();
        const reflectionBytes = Reflection.encode(state);

        const reflected = Reflection.decode(reflectionBytes);
    });
});
