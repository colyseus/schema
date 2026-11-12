import * as assert from "assert";
import { Schema, type, view, MapSchema, Callbacks } from "../src";
import { createInstanceFromReflection, createClientWithView, encodeMultiple, getDecoder, getEncoder } from "./Schema";

/**
 * Same-shape runs (SPEC.md "Message and chunks"): dirty Schemas of one class
 * whose dirty fields are the same primitives, all ADDs, collapse into one
 * chunk whose length prefix carries the run flag.
 */

class Entity extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    @type("string") name: string;
}
class Other extends Schema {
    @type("number") hp: number;
}
class Child extends Schema {
    @type("number") v: number;
}
class Vec2 extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}
class Unit extends Schema {
    @type(Vec2) position = new Vec2();
    @type("number") rotation: number;
}
class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
    @type({ map: Other }) others = new MapSchema<Other>();
    @type(Child) child: Child;
    @type("number") tick: number;
}

function readUvarint(bytes: Uint8Array, it: { offset: number }): number {
    let result = 0, shift = 0, b: number;
    do { b = bytes[it.offset++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return result;
}

/** Walk a message: `[{ refId, run, len }]` (headers decoded like the Decoder does). */
function chunksOf(bytes: Uint8Array) {
    const it = { offset: 0 };
    const out: Array<{ refId: number, run: boolean, len: number }> = [];
    let prev = -1;
    while (it.offset < bytes.byteLength) {
        const h = readUvarint(bytes, it);
        let refId: number;
        if (h % 2 === 1) refId = (h - 1) / 2;
        else { const z = h / 2; refId = prev + ((z % 2 === 1) ? -((z + 1) / 2) : z / 2); }
        prev = refId;
        const l = readUvarint(bytes, it);
        const len = (l - (l % 2)) / 2;
        out.push({ refId, run: l % 2 === 1, len });
        it.offset += len;
    }
    return out;
}

function populate(state: State, n: number) {
    for (let i = 0; i < n; i++) state.entities.set(`e${i}`, new Entity().assign({ x: i, y: i * 2, name: `e${i}` }));
}

describe("same-shape runs", () => {
    it("collapses consecutive same-class same-field patches into one run", () => {
        const state = new State();
        populate(state, 5);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        state.entities.forEach((e) => { e.x += 1; e.y += 2; });
        const patch = getEncoder(state).encode().slice();
        const chunks = chunksOf(patch);
        assert.strictEqual(chunks.length, 1, "one run for the five entities");
        assert.strictEqual(chunks[0].run, true);
        assert.strictEqual(chunks[0].refId, state.entities.get("e0")[Symbol.for("$refId") as any]);

        client.decode(patch);
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });

    it("is smaller than the same patch emitted as separate chunks", () => {
        const state = new State();
        populate(state, 50);
        getEncoder(state).encode(); getEncoder(state).discardChanges();

        state.entities.forEach((e) => { e.x += 0.5; e.y += 0.25; });
        const run = getEncoder(state).encode().byteLength;
        getEncoder(state).discardChanges();
        // 50 × (header 1 + len 1 + 2 × (op 1 + f32 5)) = 700 B as chunks; the run drops len + op bytes
        assert.ok(run < 700 * 0.85, `run ${run} B should be well below 700 B`);
    });

    it("leaves out a different class, a different field set, a DELETE or a ref field", () => {
        const state = new State();
        populate(state, 6);
        state.others.set("o", new Other().assign({ hp: 1 }));
        state.child = new Child().assign({ v: 1 });
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        const e = [0, 1, 2, 3, 4, 5].map((i) => state.entities.get(`e${i}`));
        e[0].x = 10; e[1].x = 11;          // run
        state.others.get("o").hp = 2;      // other class: own chunk
        e[2].x = 12; e[2].y = 20;          // different field set: own chunk
        e[3].x = 13; e[3].name = undefined; // DELETE inside: own chunk
        e[4].x = 14; e[5].x = 15;          // same run, across the three above
        state.child = new Child().assign({ v: 2 }); // ref field on the root: plain chunk
        state.tick = 1;

        const patch = getEncoder(state).encode().slice();
        const chunks = chunksOf(patch);
        const runs = chunks.filter((c) => c.run).length;
        assert.strictEqual(runs, 1, `expected one run, got ${JSON.stringify(chunks)}`);
        assert.ok(chunks.some((c) => !c.run), "plain chunks remain for the non-eligible structures");

        client.decode(patch);
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.strictEqual(client.entities.get("e3").name, undefined);
    });

    it("fires listen() with previous values for every run member", () => {
        const state = new State();
        populate(state, 4);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        const $ = Callbacks.get(getDecoder(client));
        const seen: Array<[string, number, number]> = [];
        client.entities.forEach((e, key) => {
            $.listen(e, "x", (value, previousValue) => { seen.push([key, value, previousValue]); }, false);
        });

        state.entities.forEach((e) => { e.x += 100; });
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();

        assert.deepStrictEqual(seen.sort(), [["e0", 100, 0], ["e1", 101, 1], ["e2", 102, 2], ["e3", 103, 3]]);
    });

    it("consumes members the client does not know", () => {
        const state = new State();
        populate(state, 3);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        // e3 is added but that frame never reaches the client
        state.entities.set("e3", new Entity().assign({ x: 3, y: 6, name: "e3" }));
        getEncoder(state).encode(); getEncoder(state).discardChanges();

        state.entities.forEach((e) => { e.x += 1; e.y += 1; });
        const patch = getEncoder(state).encode().slice();
        assert.strictEqual(chunksOf(patch).length, 1, "one run of four");

        const error = console.error;
        const errors: string[] = [];
        console.error = (...args: any[]) => { errors.push(String(args[0])); };
        try { client.decode(patch); } finally { console.error = error; }
        getEncoder(state).discardChanges();

        assert.ok(errors.some((m) => m.includes("not found")), "the unknown member is reported");
        assert.strictEqual(client.entities.size, 3);
        assert.strictEqual(client.entities.get("e0").x, 1);
        assert.strictEqual(client.entities.get("e2").y, 5);
    });

    it("round-trips long runs and large refIds", () => {
        const state = new State();
        populate(state, 400);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        for (let round = 0; round < 3; round++) {
            state.entities.forEach((e) => { e.x += 1.5; e.y -= 0.5; e.name = `n${round}`; });
            const patch = getEncoder(state).encode().slice();
            assert.ok(patch.byteLength > 128, "length prefix takes two bytes");
            client.decode(patch);
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        }
    });

    it("runs inside a view slice cover only that client's visible entities", () => {
        class VState extends Schema {
            @view() @type({ map: Entity }) entities = new MapSchema<Entity>();
        }
        const state = new VState();
        const encoder = getEncoder(state);
        const client1 = createClientWithView(state);
        const client2 = createClientWithView(state);
        const ents: Entity[] = [];
        for (let i = 0; i < 6; i++) {
            const e = new Entity().assign({ x: i, y: i, name: `e${i}` });
            state.entities.set(`e${i}`, e);
            ents.push(e);
        }
        [0, 1, 2].forEach((i) => client1.view.add(ents[i]));
        [2, 3, 4].forEach((i) => client2.view.add(ents[i]));
        encodeMultiple(encoder, state, [client1, client2]);

        ents.forEach((e) => { e.x += 10; e.y += 10; });

        // the view slice is one run per client
        const it = { offset: 0 };
        encoder.encode(it);
        const shared = it.offset;
        const pair1 = encoder.encodeView(client1.view, shared, it);
        const pair2 = encoder.encodeView(client2.view, shared, it);
        assert.deepStrictEqual(chunksOf(pair1[1]).map((c) => c.run), [true]);
        assert.deepStrictEqual(chunksOf(pair2[1]).map((c) => c.run), [true]);
        client1.state.decode([pair1[0], pair1[1]]);
        client2.state.decode([pair2[0], pair2[1]]);
        encoder.discardChanges();

        assert.deepStrictEqual(Array.from(client1.state.entities.keys()), ["e0", "e1", "e2"]);
        assert.deepStrictEqual(Array.from(client2.state.entities.keys()), ["e2", "e3", "e4"]);
        assert.strictEqual(client1.state.entities.get("e1").x, 11);
        assert.strictEqual(client2.state.entities.get("e4").y, 14);
        assert.strictEqual(client1.state.entities.get("e2").x, 12);
    });

    it("gives interleaved classes one run each", () => {
        class NState extends Schema {
            @type({ map: Unit }) units = new MapSchema<Unit>();
        }
        const state = new NState();
        for (let i = 0; i < 20; i++) {
            const u = new Unit();
            u.rotation = i;
            u.position.assign({ x: i, y: i });
            state.units.set(`u${i}`, u);
        }
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        // the queue alternates Unit, Vec2, Unit, Vec2, …
        state.units.forEach((u) => { u.rotation += 0.5; u.position.x += 1; u.position.y += 2; });
        const patch = getEncoder(state).encode().slice();
        assert.deepStrictEqual(chunksOf(patch).map((c) => c.run), [true, true]);

        client.decode(patch);
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });

    it("stops looking for more of a shape past the peek window", () => {
        const shapes = (between: number) => {
            const state = new State();
            populate(state, 2);
            for (let i = 0; i < between; i++) state.others.set(`o${i}`, new Other().assign({ hp: 1 }));
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();

            state.entities.get("e0").x = 10;
            state.others.forEach((o) => { o.hp = 2; });
            state.entities.get("e1").x = 11;
            const patch = getEncoder(state).encode().slice();
            client.decode(patch);
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            return chunksOf(patch).map((c) => c.run);
        };
        assert.deepStrictEqual(shapes(4), [true, true], "the others, then e0 + e1");
        assert.deepStrictEqual(shapes(40), [false, true, false], "e1 is out of sight: e0 keeps its own chunk");
    });

    it("gives each of several interleaved shapes its run, and the ones past the slots a chunk", () => {
        class A extends Schema { @type("number") v: number; }
        class B extends Schema { @type("number") v: number; }
        class C extends Schema { @type("number") v: number; }
        class MState extends Schema {
            @type({ map: Entity }) entities = new MapSchema<Entity>();
            @type({ map: A }) as = new MapSchema<A>();
            @type({ map: B }) bs = new MapSchema<B>();
            @type({ map: C }) cs = new MapSchema<C>();
        }
        const state = new MState();
        for (let i = 0; i < 14; i++) state.entities.set(`e${i}`, new Entity().assign({ x: i, y: i, name: `e${i}` }));
        for (let i = 0; i < 2; i++) {
            state.as.set(`${i}`, new A().assign({ v: i }));
            state.bs.set(`${i}`, new B().assign({ v: i }));
            state.cs.set(`${i}`, new C().assign({ v: i }));
        }
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        // ten shapes, two trees each: seven field sets of Entity, then A, B, C
        const e = (i: number) => state.entities.get(`e${i}`);
        const touch: Array<(n: number) => void> = [];
        for (let mask = 1; mask <= 7; mask++) {
            touch.push((n) => {
                const ent = e((mask - 1) * 2 + n);
                if (mask & 1) ent.x += 1;
                if (mask & 2) ent.y += 1;
                if (mask & 4) ent.name += "!";
            });
        }
        touch.push((n) => { state.as.get(`${n}`).v += 1; });
        touch.push((n) => { state.bs.get(`${n}`).v += 1; });
        touch.push((n) => { state.cs.get(`${n}`).v += 1; });
        // interleaved in pairs: s0 s1 s0 s1 s2 s3 s2 s3 …
        for (let k = 0; k < touch.length; k += 2) {
            touch[k](0); touch[k + 1](0); touch[k](1); touch[k + 1](1);
        }

        const patch = getEncoder(state).encode().slice();
        const runs = chunksOf(patch).map((c) => c.run);
        assert.strictEqual(runs.filter((r) => r).length, 8, JSON.stringify(runs));
        assert.strictEqual(runs.filter((r) => !r).length, 4, JSON.stringify(runs));

        client.decode(patch);
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });

    it("keeps a re-attached instance behind the op that re-introduces it", () => {
        const state = new State();
        populate(state, 3);
        state.others.set("o", new Other().assign({ hp: 1 }));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        const e2 = state.entities.get("e2");
        state.entities.delete("e2");
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();
        assert.strictEqual(client.entities.size, 2);

        // e0 and the re-staged e2 have the same dirty fields, with two chunks between them
        state.entities.get("e0").assign({ x: 50, y: 51, name: "moved" });
        state.others.get("o").hp = 2;
        state.entities.set("back", e2);
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();

        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.strictEqual(client.entities.get("back").name, "e2");
    });

    it("keeps an instance that turned public behind the op that introduces it", () => {
        class PState extends Schema {
            @type({ map: Entity }) entities = new MapSchema<Entity>();
            @view() @type({ map: Entity }) hidden = new MapSchema<Entity>();
            @type({ map: Other }) others = new MapSchema<Other>();
        }
        const state = new PState();
        const encoder = getEncoder(state);
        const client = createClientWithView(state);
        state.entities.set("e0", new Entity().assign({ x: 0, y: 0, name: "e0" }));
        state.others.set("o", new Other().assign({ hp: 1 }));
        const h = new Entity().assign({ x: 7, y: 8, name: "h" });
        state.hidden.set("h", h);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.hidden, undefined);

        // e0 and the re-staged h have the same dirty fields, with two chunks between them
        state.entities.get("e0").assign({ x: 50, y: 51, name: "moved" });
        state.others.get("o").hp = 2;
        state.entities.set("pub", h);
        encodeMultiple(encoder, state, [client]);

        assert.deepStrictEqual(client.state.entities.get("pub").toJSON(), { x: 7, y: 8, name: "h" });
        assert.strictEqual(client.state.entities.get("e0").name, "moved");
    });

    it("gives interleaved classes one run each inside a view slice", () => {
        class VState extends Schema {
            @view() @type({ map: Unit }) units = new MapSchema<Unit>();
        }
        const state = new VState();
        const encoder = getEncoder(state);
        const client = createClientWithView(state);
        const units: Unit[] = [];
        for (let i = 0; i < 8; i++) {
            const u = new Unit();
            u.rotation = i;
            u.position.assign({ x: i, y: i });
            state.units.set(`u${i}`, u);
            units.push(u);
        }
        [1, 3, 4, 6].forEach((i) => client.view.add(units[i]));
        encodeMultiple(encoder, state, [client]);

        units.forEach((u) => { u.rotation += 0.5; u.position.x += 1; u.position.y += 2; });
        const it = { offset: 0 };
        encoder.encode(it);
        const pair = encoder.encodeView(client.view, it.offset, it);
        assert.deepStrictEqual(chunksOf(pair[1]).map((c) => c.run), [true, true]);
        client.state.decode([pair[0], pair[1]]);
        encoder.discardChanges();

        assert.deepStrictEqual(Array.from(client.state.units.keys()), ["u1", "u3", "u4", "u6"]);
        for (const i of [1, 3, 4, 6]) {
            assert.deepStrictEqual(client.state.units.get(`u${i}`).toJSON(), units[i].toJSON());
        }
    });
});
