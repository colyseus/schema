import * as assert from "assert";
import { Schema, type, MapSchema, ArraySchema, Encoder } from "../../src";
import { Encoder6, Reflection6 } from "../../src/v6";

class Position extends Schema { @type("number") x: number; @type("number") y: number; }
class Player extends Schema {
    @type("string") name: string;
    @type(Position) position = new Position();
    @type(["number"]) scores = new ArraySchema<number>();
}
class State extends Schema { @type({ map: Player }) players = new MapSchema<Player>(); }

const KEY = (i: number) => i.toString(36).padStart(8, "x");

describe("v6 smoke", () => {
    it("bloat snapshot round-trips and is ~40% smaller", () => {
        const state = new State();
        for (let i = 0; i < 1000; i++) {
            const p = new Player(); p.name = `Player ${i}`; p.position.x = i; p.position.y = i;
            for (let j = 0; j < 5; j++) p.scores.push(j);
            state.players.set(KEY(i), p);
        }
        const enc5 = new Encoder(state); enc5.sharedBuffer = new Uint8Array(1 << 20);
        const v5 = enc5.encodeAll();
        const enc6 = new Encoder6(state); enc6.sharedBuffer = new Uint8Array(1 << 20);
        const v6 = enc6.encodeAll();
        console.log("      encodeAll bytes: v5", v5.length, "v6", v6.length, `(${(100 * (1 - v6.length / v5.length)).toFixed(1)}% smaller)`);

        const dec6 = Reflection6.decode<State>(Reflection6.encode(enc6));
        dec6.decode(v6);
        assert.deepStrictEqual(dec6.state.toJSON(), state.toJSON());
        for (const refId in enc6.root.refCount) {
            assert.strictEqual(dec6.root.refCount[refId] ?? 0, enc6.root.refCount[refId], "refCount " + refId);
        }
        assert.ok(v6.length < v5.length * 0.65);
    });
});
