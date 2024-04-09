import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder, Decoder, } from "../src";
import { createInstanceFromReflection } from "./Schema";

describe("StateView", () => {

    class Vec3 extends Schema {
        @type("number") x: number;
        @type("number") y: number;
        @type("number") z: number;
    }

    class Entity extends Schema {
        @type(Vec3) position = new Vec3().assign({ x: 0, y: 0, z: 0 });
    }

    class Card extends Schema {
        @type("string") suit: string;
        @type("number") num: number;
    }

    class Player extends Entity {
        @type(Vec3) rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
        @type("string") secret: string = "private info only for this player";
        @type([Card]) cards = new ArraySchema<Card>(
            new Card().assign({ suit: "Hearts", num: 1 }),
            new Card().assign({ suit: "Spaces", num: 2 }),
            new Card().assign({ suit: "Diamonds", num: 3 }),
        );
    }

    class Team extends Schema {
        @type({ map: Entity }) entities = new MapSchema<Entity>();
    }

    class State extends Schema {
        @type("number") num: number = 0;
        @type("string") str = "Hello world!"
        @view() @type([Team]) teams = new ArraySchema<Team>();
    }

    it("should filter out a property", () => {
        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type("string") prop2 = "Secret info";
        }

        const state = new State();
        const encoder = new Encoder(state);

        const it = { offset: 0 };
        const sharedEncode = encoder.encode(it);
        const sharedOffset = it.offset;

        const sharedDecode = createInstanceFromReflection(state);
        sharedDecode.decode(sharedEncode);
        assert.strictEqual(sharedDecode.prop1, state.prop1);
        assert.strictEqual(sharedDecode.prop2, undefined);

        const view1 = new StateView();
        view1.add(state);
        const decoded1 = createInstanceFromReflection(state);
        decoded1.decode(encoder.encodeView(view1, sharedOffset, it));
        assert.strictEqual(decoded1.prop1, state.prop1);
        assert.strictEqual(decoded1.prop2, state.prop2);

        const view2 = new StateView();
        const decoded2 = createInstanceFromReflection(state);
        decoded2.decode(encoder.encodeView(view2, sharedOffset, it));
        assert.strictEqual(decoded2.prop1, state.prop1);
        assert.strictEqual(decoded2.prop2, undefined);
    });

})