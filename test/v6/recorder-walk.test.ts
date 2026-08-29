import { Schema, type, MapSchema, ArraySchema } from "../../src";
import { makeSides, join, tick } from "./harness";

/**
 * The v6 encoder walks `ChangeTree` recorder storage directly (dirty bitmasks,
 * packed op bytes, `collDirty` + `collPureOps` interleave) instead of
 * `forEachWithCtx`. A recorder-layout change must keep both walks agreeing:
 * random op mixes on ≤ 8-field (packed) and > 8-field (`ops` array) Schemas
 * and on collections with pure ops must decode identically under both codecs.
 */
class Narrow extends Schema {
    @type("number") f0: number; @type("number") f1: number; @type("string") f2: string; @type("number") f3: number;
    @type("number") f4: number; @type("string") f5: string; @type("number") f6: number; @type("number") f7: number;
}
class Wide extends Schema {}
for (let i = 0; i < 12; i++) type(i % 2 ? "string" : "number")(Wide.prototype, "w" + i);

class State extends Schema {
    @type(Narrow) narrow = new Narrow();
    @type(Wide) wide = new Wide();
    @type({ map: "number" }) map = new MapSchema<number>();
    @type(["number"]) arr = new ArraySchema<number>();
}

function lcg(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe("v6 recorder walk ≡ ChangeTree.forEachWithCtx", () => {
    it("random field op mixes on packed and wide Schemas, collections with CLEAR/REVERSE", () => {
        const sides = makeSides(() => { const s = new State(); for (let i = 0; i < 5; i++) { s.map.set("k" + i, i); s.arr.push(i); } return s; });
        sides.forEach((s) => join(s));
        for (let t = 0; t < 60; t++) {
            tick(sides, (st) => {
                const rnd = lcg(42 + t); // same sequence for both twins
                for (let i = 0; i < 8; i++) {
                    const r = rnd();
                    if (r < 0.4) (st.narrow as any)["f" + i] = (i === 2 || i === 5) ? "s" + t : t + i;
                    else if (r < 0.55) (st.narrow as any)["f" + i] = undefined;
                    else if (r < 0.65) { (st.narrow as any)["f" + i] = undefined; (st.narrow as any)["f" + i] = (i === 2 || i === 5) ? "d" + t : -t; }
                }
                for (let i = 0; i < 12; i++) {
                    const r = rnd();
                    if (r < 0.4) (st.wide as any)["w" + i] = (i % 2) ? "s" + t : t + i;
                    else if (r < 0.5) (st.wide as any)["w" + i] = undefined;
                }
                const m = rnd();
                if (m < 0.2) st.map.set("k" + Math.floor(rnd() * 8), t);
                else if (m < 0.35) st.map.delete("k" + Math.floor(rnd() * 8));
                else if (m < 0.4) { st.map.clear(); st.map.set("after", t); }
                const a = rnd();
                if (a < 0.25) st.arr.push(t);
                else if (a < 0.4 && st.arr.length > 0) st.arr[Math.floor(rnd() * st.arr.length)] = -t;
                else if (a < 0.5 && st.arr.length > 0) st.arr.splice(Math.floor(rnd() * st.arr.length), 1);
                else if (a < 0.55) st.arr.reverse();
                else if (a < 0.6) { st.arr.push(1); st.arr.reverse(); }
                else if (a < 0.63) { st.arr.clear(); st.arr.push(t, t + 1); }
            });
        }
    });
});
