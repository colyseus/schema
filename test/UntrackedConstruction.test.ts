import * as assert from "assert";
import { Schema, type, schema, t, ArraySchema, MapSchema, SetSchema, Encoder, Decoder, Reflection, Callbacks, $changes } from "../src";
import { InputEncoder, InputDecoder } from "../src/input";
import { createTree, createStubTree, installTracking, upgradeTree } from "../src/encoder/ChangeTree";

// A bundle that never imports `Encoder` constructs every instance with an
// untracked stub (`createTree`). Node always loads the encoder module, so
// these tests switch the factory back to the stub for their duration.
describe("Construction without the encoder module (client bundles)", () => {
    let tracked: typeof createTree;
    const untracked = () => installTracking(createStubTree, upgradeTree!);
    const restoreTracking = () => installTracking(tracked, upgradeTree!);

    before(() => { tracked = createTree; untracked(); });
    after(() => restoreTracking());

    class Item extends Schema {
        @type("number") x: number = 5;
        @type("string") name: string;
    }
    class State extends Schema {
        @type(Item) item: Item;
        @type([Item]) items = new ArraySchema<Item>();
        @type({ map: Item }) byId = new MapSchema<Item>();
        @type({ set: "string" }) tags = new SetSchema<string>();
        @type(["number"]) nums = new ArraySchema<number>();
        @type("number") score: number = 1;
    }

    it("builds untracked trees", () => {
        const state = new State();
        assert.strictEqual((state[$changes] as any).isTracked, false);
        assert.strictEqual((state.items[$changes] as any).isTracked, false);
        assert.strictEqual((state.byId[$changes] as any).isTracked, false);
    });

    it("applies field initializers, constructor props and schema() defaults", () => {
        const state = new State();
        assert.strictEqual(state.score, 1);
        assert.strictEqual(new Item().x, 5);
        assert.strictEqual(new Item().assign({ name: "a" }).name, "a");

        const Built = schema({ a: t.number().default(3), list: t.array("string") }, "UntrackedBuilt");
        assert.strictEqual((new Built() as any).a, 3);
        const built: any = new Built({ list: ["x"] } as any);
        assert.strictEqual(built.a, 3);
        assert.deepStrictEqual(built.list.toArray(), ["x"]);
    });

    it("mutates every collection kind", () => {
        const state = new State();
        state.items.push(new Item().assign({ x: 3 }), new Item().assign({ x: 1 }), new Item().assign({ x: 2 }));
        state.items.splice(0, 1);
        state.items.sort((a, b) => a.x - b.x);
        state.items.set(0, new Item().assign({ x: 9 }));
        state.nums.push(3, 1, 2); state.nums.reverse(); state.nums.shift(); state.nums.unshift(7);
        state.byId.set("a", new Item()); state.byId.set("b", new Item()); state.byId.delete("a");
        state.tags.add("x"); state.tags.add("y"); state.tags.delete("x");

        assert.deepStrictEqual(state.items.map((i) => i.x), [9, 2]);
        assert.deepStrictEqual(state.nums.toArray(), [7, 1, 3]);
        assert.deepStrictEqual([...state.byId.keys()], ["b"]);
        assert.deepStrictEqual([...state.tags.values()], ["y"]);

        state.byId.clear();
        state.items.clear();
        assert.strictEqual(state.byId.size, 0);
        assert.strictEqual(state.items.length, 0);

        new ArraySchema(new Item(), new Item());
        new MapSchema({ a: new Item() });
        new SetSchema(["a", "b"]);
    });

    it("assigns, clones and serializes to JSON", () => {
        const state = new State().assign({ item: new Item().assign({ name: "n" }), score: 2 });
        state.items.push(new Item());
        const copy = state.clone();
        assert.deepStrictEqual(copy.toJSON(), state.toJSON());
        assert.strictEqual(copy.item.name, "n");
    });

    it("encodes inputs with InputEncoder", () => {
        class Input extends Schema {
            @type("boolean") up: boolean;
            @type("float32") x: number;
        }
        const input = new Input();
        const encoder = new InputEncoder(input);
        input.up = true; input.x = 1.5;

        const received = new Input();
        new InputDecoder(received).decode(encoder.encode());
        assert.strictEqual(received.up, true);
        assert.strictEqual(received.x, 1.5);
        assert.strictEqual(encoder.encode().length, 0);
    });

    it("decodes into a client-built state (class and Reflection clients)", () => {
        restoreTracking();
        const state = new State();
        const encoder = new Encoder(state);
        const handshake = Reflection.encode(encoder);
        untracked();

        const client = new State();
        const decoder = new Decoder(client);
        const reflected = Reflection.decode(handshake);
        let added = 0, removed = 0;
        Callbacks.get(decoder).onAdd("items", () => { added++; });
        Callbacks.get(decoder).onRemove("items", () => { removed++; });
        decoder.decode(encoder.encodeAll());
        reflected.decode(encoder.encodeAll());

        let seed = 7;
        const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
        for (let tick = 0; tick < 200; tick++) {
            let patch: Uint8Array;
            restoreTracking();
            try {
                for (let k = 0; k < 4; k++) {
                    switch (rnd(9)) {
                        case 0: state.items.push(new Item().assign({ x: rnd(100) })); break;
                        case 1: if (state.items.length) { state.items.splice(rnd(state.items.length), 1); } break;
                        case 2: state.byId.set("k" + rnd(8), new Item().assign({ x: rnd(50) })); break;
                        case 3: state.byId.delete("k" + rnd(8)); break;
                        case 4: state.tags.add("t" + rnd(6)); break;
                        case 5: state.tags.delete("t" + rnd(6)); break;
                        case 6: state.nums.push(rnd(1000)); if (state.nums.length > 10) { state.nums.shift(); } break;
                        case 7: state.score = rnd(1000); state.item = new Item().assign({ x: rnd(9) }); break;
                        case 8: if (rnd(20) === 0) { state.items.clear(); state.byId.clear(); } else if (state.items.length) { state.items[rnd(state.items.length)].x = rnd(100); } break;
                    }
                }
                patch = encoder.encode();
                encoder.discardChanges();
            } finally { untracked(); }

            decoder.decode(patch);
            reflected.decode(patch);
            assert.deepStrictEqual(client.toJSON(), state.toJSON(), `class client, tick ${tick}`);
            assert.deepStrictEqual(reflected.state.toJSON(), state.toJSON(), `Reflection client, tick ${tick}`);
        }
        assert.ok(added > 0 && removed > 0);
    });

    it("is upgraded to tracked trees when attached to an Encoder", () => {
        const state = new State().assign({ item: new Item().assign({ name: "n" }) });
        state.items.push(new Item().assign({ x: 1 }));
        state.byId.set("a", new Item().assign({ x: 2 }));
        state.tags.add("t");

        restoreTracking();
        try {
            const encoder = new Encoder(state);
            assert.notStrictEqual((state.items[$changes] as any).isTracked, false);

            const decoded = new State();
            const decoder = new Decoder(decoded);
            decoder.decode(encoder.encodeAll());
            assert.deepStrictEqual(decoded.toJSON(), state.toJSON());

            state.items.push(new Item().assign({ x: 3 })); // constructed tracked now
            state.byId.get("a")!.x = 4;
            decoder.decode(encoder.encode());
            assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
        } finally {
            untracked();
        }
    });
});
