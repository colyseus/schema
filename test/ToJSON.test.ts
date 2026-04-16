import { ArraySchema, Encoder, MapSchema, schema, SchemaType, t } from "../src";
import assert from "assert";
import { createInstanceFromReflection, getEncoder } from "./Schema";

describe("toJSON", () => {
    const Item = schema({
        name: t.string(),
        attributes: t.map("string")
    }, "Item");
    type Item = SchemaType<typeof Item>;

    const Position = schema({
        x: t.number(),
        y: t.number()
    }, "Position");
    type Position = SchemaType<typeof Position>;

    const Player = schema({
        name: t.string(),
        x: t.number(),
        y: t.number(),
        position: Position,
        items: t.array(Item)
    }, "Player");
    type Player = SchemaType<typeof Player>;

    const State = schema({
        str: t.string(),
        players: t.map(Player)
    }, "State");
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
