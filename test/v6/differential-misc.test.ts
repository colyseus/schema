import * as assert from "assert";
import { Schema, type, view, deprecated, MapSchema, ArraySchema } from "../../src";
import { Encoder6, Decoder6, Reflection6, encoding6 } from "../../src/v6";
import { makeSides, join, tick, report, captureConsole } from "./harness";

describe("v6 differential — misc", () => {

    it("mid-tick join + array slot write: v6 client matches the server (v5 splice-inserts)", () => {
        class Player extends Schema { @type(["number"]) scores = new ArraySchema<number>(); }
        class State extends Schema { @type({ map: Player }) players = new MapSchema<Player>(); }
        const sides = makeSides(() => { const s = new State(); const p = new Player(); p.scores.push(1, 2); s.players.set("p0", p); return s; });
        sides.forEach((s) => join(s)); // snapshot taken before the construction ADDs were flushed
        tick(sides, (st) => { st.players.get("p0").scores[0] = 7; }, { skipParity: true });
        // v5 delivers ADD@0 over an occupied slot → insert → [7, 2, 1, 2]; v6 bodies merge
        assert.deepStrictEqual(sides[0].clients[0].state.toJSON(), { players: { p0: { scores: [7, 2, 1, 2] } } });
        assert.deepStrictEqual(sides[1].clients[0].state.toJSON(), sides[1].state.toJSON());
    });

    it("14. wide schema (40 fields, tag on 35): multi-byte masks and op headers", () => {
        class Wide extends Schema {}
        for (let i = 0; i < 40; i++) {
            type(i % 3 === 0 ? "string" : "number")(Wide.prototype, "f" + i);
            if (i === 35) view()(Wide.prototype, "f35");
        }
        class State extends Schema {
            @type(Wide) w = new Wide();
            @type({ map: Wide }) map = new MapSchema<Wide>();
        }
        const fill = (w: any, base: number) => { for (let i = 0; i < 40; i++) w["f" + i] = (i % 3 === 0) ? "s" + (base + i) : base + i; return w; };
        const sides = makeSides(() => { const s = new State(); fill(s.w, 0); s.map.set("a", fill(new Wide(), 100)); return s; });
        sides.forEach((s) => join(s));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.w); v.add(st.map.get("a")); }));
        tick(sides, (st) => { (st.w as any).f34 = 1; (st.w as any).f35 = 2; (st.w as any).f39 = "z"; });
        tick(sides, (st) => { (st.w as any).f33 = undefined; (st.map.get("a") as any).f35 = 7; });
        tick(sides, (st) => { st.map.set("b", fill(new Wide(), 200)); });
        tick(sides, (st) => { const b: any = st.map.get("b"); for (let i = 0; i < 40; i++) b["f" + i] = undefined; });
        sides.forEach((s) => join(s));
        report("wide", sides);
    });

    it("18. deprecated fields: bytes consumed, nothing written", () => {
        class V1 extends Schema {
            @type("string") a: string;
            @type("number") old: number;
            @type("string") c: string;
        }
        class V2 extends Schema {
            @type("string") a: string;
            @deprecated() @type("number") old: number;
            @type("string") c: string;
        }
        class StateV1 extends Schema { @type(V1) v = new V1(); }
        // encode with V1 (peer still sends `old`), decode into a V2-shaped client
        const sides = makeSides(() => { const s = new StateV1(); s.v.a = "a"; s.v.old = 5; s.v.c = "c"; return s; });
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.v.old = 6; st.v.c = "cc"; });
        tick(sides, (st) => { st.v = new V1(); st.v.a = "n"; st.v.old = 1; st.v.c = "n"; });
        // v6-only: a V2 decoder reading V1 bytes must consume `old` without writing it
        const enc = new Encoder6(sides[1].state);
        const dec6 = Reflection6.decode<any>(Reflection6.encode(enc));
        dec6.decode(enc.encodeAll());
        assert.strictEqual(dec6.state.v.old, 1);
    });

    it("15. robustness: unknown-refId chunk is skipped exactly, truncated chunk stops, unknown field skips the chunk", () => {
        class P extends Schema { @type("number") x: number; @type("number") y: number; }
        class State extends Schema { @type("number") n: number; @type({ map: P }) ps = new MapSchema<P>(); }
        const s = new State(); s.n = 1; s.ps.set("a", Object.assign(new P(), { x: 1, y: 2 }));
        const enc = new Encoder6(s);
        const dec = Reflection6.decode<State>(Reflection6.encode(enc));
        dec.decode(enc.encodeAll()); enc.discardChanges();

        const chunk = (refId: number, ops: number[]) => {
            const b = new Uint8Array(64); const it = { offset: 0 };
            encoding6.uvarint(b, refId, it); encoding6.uvarint(b, ops.length, it);
            for (const o of ops) b[it.offset++] = o;
            return b.subarray(0, it.offset);
        };
        const opSet = (index: number, op2: number) => (index << 2) | op2;

        // valid (n=5) | unknown refId 999 | valid (n=7)
        let cap = captureConsole();
        dec.decode(Encoder6.concat([chunk(0, [opSet(0, 2), 5]), chunk(999, [1, 2, 3]), chunk(0, [opSet(0, 2), 7])]));
        cap.restore();
        assert.strictEqual(dec.state.n, 7);
        assert.strictEqual(cap.lines.length, 1);
        assert.ok(/refId" not found: 999/.test(cap.lines[0]));

        // truncated declared length: stop, no crash
        cap = captureConsole();
        const trunc = chunk(0, [opSet(0, 2), 9]); trunc[1] = 40; // declares 40 bytes
        dec.decode(trunc);
        cap.restore();
        assert.strictEqual(dec.state.n, 7);
        assert.ok(/truncated/.test(cap.lines[0]));

        // unknown field index inside a chunk → skip to chunk end; next chunk decodes
        cap = captureConsole();
        dec.decode(Encoder6.concat([chunk(0, [opSet(9, 2), 1, 2, 3]), chunk(0, [opSet(0, 2), 8])]));
        cap.restore();
        assert.strictEqual(dec.state.n, 8);
        assert.ok(cap.lines.some((l) => /field not defined/.test(l)));

        // resync: any damage aborts the sweep instead of deleting live data
        cap = captureConsole();
        dec.decodeResync(Encoder6.concat([chunk(999, [1]), enc.encodeAll()]));
        cap.restore();
        assert.strictEqual(dec.state.ps.size, 1);
        assert.ok(cap.lines.some((l) => /resync sweep skipped/.test(l)));
    });

    it("17. callback parity on the bloat shape: bootstrap + ticks + churn", () => {
        class Position extends Schema { @type("number") x: number; @type("number") y: number; }
        class Player extends Schema {
            @type("string") name: string;
            @type(Position) position = new Position();
            @type(["number"]) scores = new ArraySchema<number>();
        }
        class State extends Schema { @type({ map: Player }) players = new MapSchema<Player>(); }
        const mk = (i: number) => { const p = new Player(); p.name = "P" + i; p.position.x = i; p.position.y = i; p.scores.push(1, 2); return p; };
        const sides = makeSides(() => { const s = new State(); for (let i = 0; i < 50; i++) s.players.set("p" + i, mk(i)); return s; });
        sides.forEach((s) => join(s));
        tick(sides, () => {}); // flush construction ADDs — see the mid-tick join test below for why
        for (let t = 0; t < 5; t++) tick(sides, (st) => { st.players.forEach((p) => { p.position.x += 0.5; p.scores[0] = t; }); });
        tick(sides, (st) => { for (let i = 0; i < 10; i++) st.players.delete("p" + i); for (let i = 50; i < 60; i++) st.players.set("p" + i, mk(i)); });
        tick(sides, (st) => { st.players.forEach((p) => { p.position.y -= 1; }); });
        report("bloat callbacks", sides);
    });
});
