import * as assert from "assert";
import { Reflection, type, Schema, MapSchema, ArraySchema } from "../src";
import { deprecated } from "../src/annotations";
import "./Schema";
import { getEncoder, getDecoder, createInstanceFromReflection } from "./Schema";

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
        state.map.set('one', new PlayerV1().assign({ x: 10, y: 20 }));

        const decodedStateV2 = new StateV2();
        decodedStateV2.decode(state.encode());
        assert.strictEqual("Hello world", decodedStateV2.str);

        // fields the V1 peer doesn't know about keep their defaults
        assert.strictEqual(undefined, decodedStateV2.countdown);

        // the shared portion of the tree must decode for real, not vacuously
        assert.deepStrictEqual(["one"], Array.from(decodedStateV2.map.keys()));
        assert.strictEqual(10, decodedStateV2.map.get("one").x);
        assert.strictEqual(20, decodedStateV2.map.get("one").y);

        // fields the V1 peer never sends stay undefined: decoder-created
        // instances don't run field initializers, so a newer client does NOT
        // get the declared default for a field the older peer lacks.
        assert.strictEqual(undefined, decodedStateV2.map.get("one").name);
        assert.strictEqual(undefined, decodedStateV2.map.get("one").arrayOfStrings);

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
            // @ts-ignore
            arrayOfStrings: new ArraySchema("one"),
        }));

        const encoded = state.encode();

        const decodedStateV1 = new StateV1();
        decodedStateV1.decode(encoded);
        assert.strictEqual("Hello world", decodedStateV1.str);
    });

    it("should allow reflection", () => {
        const state = new StateV2();
        const encoder = getEncoder(state);
        const reflectionBytes = Reflection.encode(encoder);

        const reflected = Reflection.decode(reflectionBytes);
        assert.ok(reflected.state);

        //
        // The @deprecated() slot must keep its wire index through reflection.
        // Dropping it shifts every later field down, and the reflected peer
        // then silently loses them.
        //
        state.str = "Hello world";
        state.countdown = 10;
        state.map.set("one", new PlayerV2().assign({ x: 10, y: 20, name: "Reflected" }));

        const reflectedState = createInstanceFromReflection(state, encoder);
        getDecoder(reflectedState).decode(encoder.encode());

        assert.strictEqual("Hello world", reflectedState.str);
        assert.strictEqual(10, reflectedState.countdown); // index 3, after the deprecated slot
        assert.strictEqual("Reflected", reflectedState.map.get("one").name);
        assert.deepStrictEqual(state.toJSON(), reflectedState.toJSON());
    });
});
