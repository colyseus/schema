import { ArraySchema, Encoder, MapSchema, schema, SchemaType } from "../src";
import assert from "assert";
import { createInstanceFromReflection, getEncoder } from "./Schema";

describe("toJSON", () => {
    const Item = schema({
        name: "string",
        attributes: { map: "string" }
    });
    type Item = SchemaType<typeof Item>;

    const Position = schema({
        x: "number",
        y: "number"
    });
    type Position = SchemaType<typeof Position>;

    const Player = schema({
        name: "string",
        x: "number",
        y: 'number',
        position: Position,
        items: { array: Item }
    });
    type Player = SchemaType<typeof Player>;

    const State = schema({
        str: "string",
        players: { map: Player }
    });
    type State = SchemaType<typeof State>;

    it("should allow to fill complex object using .assign() with a JSON object", () => {
        const state = new State();
        getEncoder(state);

        state.restore({
            str: "Hello world",
            players: {
                one: { name: "Jake", x: 100, y: 200, position: { x: 10, y: 20 }, items: [{ name: "Sword", attributes: { damage: "10" } }] },
                two: { name: "Katarina", x: 300, y: 400, position: { x: 30, y: 40 }, items: [{ name: "Bow", attributes: { damage: "10" } }] }
            }
        });

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
    });

});