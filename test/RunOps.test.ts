import * as assert from "assert";
import { Schema, type, view, MapSchema, Callbacks } from "../src";
import { createInstanceFromReflection, createClientWithView, encodeMultiple, getDecoder, getEncoder } from "./Schema";

/**
 * Same-shape runs (SPEC.md "Message and chunks"): consecutive dirty Schemas of
 * one class whose dirty fields are the same primitives, all ADDs, collapse
 * into one chunk whose length prefix carries the run flag.
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

    it("breaks on a different class, a different field set, a DELETE or a ref field", () => {
        const state = new State();
        populate(state, 6);
        state.others.set("o", new Other().assign({ hp: 1 }));
        state.child = new Child().assign({ v: 1 });
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        const e = [0, 1, 2, 3, 4, 5].map((i) => state.entities.get(`e${i}`));
        e[0].x = 10; e[1].x = 11;          // run of 2
        state.others.get("o").hp = 2;      // other class: breaks
        e[2].x = 12; e[2].y = 20;          // different field set from e3
        e[3].x = 13; e[3].name = undefined; // DELETE inside: not a run member
        e[4].x = 14; e[5].x = 15;          // run of 2
        state.child = new Child().assign({ v: 2 }); // ref field on the root: plain chunk
        state.tick = 1;

        const patch = getEncoder(state).encode().slice();
        const chunks = chunksOf(patch);
        const runs = chunks.filter((c) => c.run).length;
        assert.ok(runs >= 2, `expected at least two runs, got ${JSON.stringify(chunks)}`);
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
});
