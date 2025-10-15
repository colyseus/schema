import * as assert from "assert";

import { State, Player, getCallbacks, getEncoder, createInstanceFromReflection, getDecoder, assertDeepStrictEqualEncodeAll } from "./Schema";
import { ArraySchema, Schema, type, Reflection, $changes, Metadata, SetSchema, MapSchema } from "../src";
import { $numFields } from "../src/types/symbols";

describe("Metadata Tests", () => {

    it("Metadata.setFields() on external class", () => {
        class RawState {
            x: number;
            y: number;
            constructor() {
                Schema.initialize(this);
            }
        }
        Metadata.setFields(RawState, { x: "number", y: "number" });

        class State extends Schema {
            @type(RawState) raw = new RawState();
        }

        const state = new State();
        state.raw.x = 10;
        state.raw.y = 20;

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        assert.strictEqual((RawState as any)[Symbol.metadata][$numFields], 1);
        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

    it("Metadata.setFields() on inherited external class", () => {
        class RawState {
            x: number;
            y: number;
            constructor() {
                Schema.initialize(this);
            }
        }
        Metadata.setFields(RawState, { x: "number", y: "number" });

        class Raw2State extends RawState {
            z: number;
            constructor() {
                super();
                Schema.initialize(this);
            }
        }
        Metadata.setFields(Raw2State, { z: "number" });

        class State extends Schema {
            @type(RawState) raw = new RawState();
            @type(Raw2State) raw2 = new Raw2State();
        }

        const state = new State();
        state.raw.x = 10;
        state.raw.y = 20;

        state.raw2.x = 10;
        state.raw2.y = 20;
        state.raw2.z = 30;

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        assert.strictEqual((Raw2State as any)[Symbol.metadata][$numFields], 2);
        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

    it("should support nested external classes", () => {
        class Body {
            name: string;
            position: Vec2;
            rotation: Vec2;
        }
        class Vec2 {
            x: number;
            y: number;
        }
        Metadata.setFields(Body, {
            name: "string",
            position: Vec2,
            rotation: Vec2,
        });
        Metadata.setFields(Vec2, {
            x: "number",
            y: "number",
        });

        class State extends Schema {
            @type({ map: Body }) bodies = new MapSchema<Body>();
        }

        const state = new State();

        const body = new Body();
        Schema.initialize(body);

        body.name = "testing";
        body.position = new Vec2();
        Schema.initialize(body.position);

        body.position.x = 10;
        body.position.y = 20;

        body.rotation = new Vec2();
        Schema.initialize(body.rotation);

        body.rotation.x = 10;
        body.rotation.y = 20;

        state.bodies.set('one', body);

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

});
