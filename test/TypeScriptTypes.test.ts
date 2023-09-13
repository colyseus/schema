import * as assert from "assert";
import { State, Player, DeepState, DeepMap, DeepChild, Position, DeepEntity } from "./Schema";
import { Schema, ArraySchema, MapSchema, type } from "../src";

describe("TypeScript Types", () => {
    it("strict null/undefined checks", () => {
        class Player extends Schema {
            @type("number") orderPriority: number;
        }
        class MyState extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new MyState();
        state.players.set("one", new Player().assign({
            orderPriority: null,
        }));
        state.encodeAll();
        console.log("DONE!");
    });
});