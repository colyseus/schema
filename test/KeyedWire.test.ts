import * as assert from "assert";
import { Schema, type, view, MapSchema, SetSchema } from "../src";
import { $changes } from "../src/types/symbols";
import { KeyedRecorder } from "../src/encoder/KeyedRecorder";
import {
    createInstanceFromReflection, assertDeepStrictEqualEncodeAll, assertRefIdCounts, getEncoder, getCallbacks,
    createClientWithView, encodeMultiple,
} from "./Schema";

class Item extends Schema {
    @type("string") name: string;
}

function item(name: string) {
    const i = new Item();
    i.name = name;
    return i;
}

describe("Keyed collections wire format (Map / Set)", () => {

    it("set / clear / set in one tick: CLEAR ships first, then the re-adds", () => {
        class State extends Schema {
            @type({ map: "number" }) scores = new MapSchema<number>();
        }
        const state = new State();
        state.scores.set("a", 1);
        state.scores.set("b", 2);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        state.scores.set("c", 3);
        state.scores.clear();
        state.scores.set("d", 4);
        const rec = (state.scores as any)[$changes].rec as KeyedRecorder;
        assert.strictEqual(rec.cleared, true);
        assert.deepStrictEqual(rec.indexes(), [0]); // indexes restart after clear

        let removed = 0;
        getCallbacks(client)(client).scores.onRemove(() => removed++);
        client.decode(state.encode());
        assert.deepStrictEqual(client.scores.toJSON(), { d: 4 });
        assert.strictEqual(removed, 2);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("a removed entry keeps its wire identity until the end of the tick; re-set reuses it", () => {
        class State extends Schema {
            @type({ map: Item }) items = new MapSchema<Item>();
        }
        const state = new State();
        state.items.set("k", item("one"));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        state.items.delete("k");
        state.items.set("k", item("two"));
        assert.strictEqual(state.items.indexByKey.get("k"), 0, "same-tick re-set reuses the index");
        client.decode(state.encode());
        assert.deepStrictEqual(client.items.toJSON(), { k: { name: "two" } });
        assertRefIdCounts(state, client);

        state.items.delete("k");
        client.decode(state.encode());
        assert.strictEqual(state.items.indexByKey.has("k"), false, "purged after the tick");
        assert.deepStrictEqual(client.items.toJSON(), {});
        assertRefIdCounts(state, client);
    });

    it("a DELETE under a view resolves the removed value's visibility through the recorder", () => {
        class State extends Schema {
            @view() @type({ map: Item }) items = new MapSchema<Item>();
        }
        const state = new State();
        const encoder = getEncoder(state);
        state.items.set("a", item("a"));
        state.items.set("b", item("b"));

        const client1 = createClientWithView(state);
        const client2 = createClientWithView(state);
        client1.view.add(state.items.get("a"));
        client2.view.add(state.items.get("b"));
        encodeMultiple(encoder, state, [client1, client2]);
        assert.deepStrictEqual(Object.keys(client1.state.items.toJSON()), ["a"]);
        assert.deepStrictEqual(Object.keys(client2.state.items.toJSON()), ["b"]);

        state.items.delete("a");
        state.items.delete("b");
        const patches = encodeMultiple(encoder, state, [client1, client2]);
        assert.deepStrictEqual(client1.state.items.toJSON(), {});
        assert.deepStrictEqual(client2.state.items.toJSON(), {});
        // each client received exactly its own entry's DELETE (one keyed op)
        assert.strictEqual(patches[0].byteLength, patches[1].byteLength);
    });

    describe("byte layout: uvarint(index * 4 + op) [key] value?", () => {
        // patch = one chunk for the map: [header = refId 1 * 2 + 1 = 3][len * 2][ops...]
        function patch(state: Schema): number[] {
            return Array.from(getEncoder(state).encode());
        }
        function bootstrap(state: Schema) {
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();
            return client;
        }

        it("REPLACE on a primitive map is one byte for indexes below 32", () => {
            class State extends Schema {
                @type({ map: "number" }) scores = new MapSchema<number>();
            }
            const state = new State();
            state.scores.set("a", 1);
            state.scores.set("b", 2);
            state.scores.set("c", 3);
            state.scores.set("d", 4);
            const client = bootstrap(state);

            state.scores.set("d", 7); // index 3
            assert.deepStrictEqual(patch(state), [3, 4, 3 * 4 + 0, 7]);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(client.scores.toJSON(), { a: 1, b: 2, c: 3, d: 7 });

            state.scores.delete("c"); // index 2
            assert.deepStrictEqual(patch(state), [3, 2, 2 * 4 + 1]);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(client.scores.toJSON(), { a: 1, b: 2, d: 7 });

            state.scores.set("e", 5); // index 4, string key "e"
            assert.deepStrictEqual(patch(state), [3, 8, 4 * 4 + 2, 1, 0x65, 5]);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(client.scores.toJSON(), { a: 1, b: 2, d: 7, e: 5 });
        });

        it("CLEAR is 0x03, first in its chunk; indexes restart", () => {
            class State extends Schema {
                @type({ map: "number" }) scores = new MapSchema<number>();
            }
            const state = new State();
            state.scores.set("a", 1);
            const client = bootstrap(state);

            state.scores.clear();
            state.scores.set("d", 4);
            assert.deepStrictEqual(patch(state), [3, 10, 3, 0 * 4 + 2, 1, 0x64, 4]);
            client.decode(getEncoder(state).encode());
            assert.deepStrictEqual(client.scores.toJSON(), { d: 4 });
        });

        it("index >= 32 takes a two-byte op", () => {
            class State extends Schema {
                @type({ map: "number" }) scores = new MapSchema<number>();
            }
            const state = new State();
            for (let i = 0; i < 40; i++) state.scores.set(`k${i}`, i);
            const client = bootstrap(state);

            state.scores.delete("k32"); // 32 * 4 + 1 = 129 → [0x81, 0x01]
            assert.deepStrictEqual(patch(state), [3, 4, 0x81, 0x01]);
            client.decode(getEncoder(state).encode());
            assert.strictEqual(client.scores.has("k32"), false);
            assert.strictEqual(client.scores.size, 39);
        });

        it("a number key rides as a dynamic number on ADD; later ops carry no key", () => {
            class State extends Schema {
                @type({ map: "number", key: "number" }) scores = new MapSchema<number, number>();
            }
            const state = new State();
            state.scores.set(5, 1);
            const client = bootstrap(state);

            state.scores.set(300, 2); // index 1, key 300 → uint16 (0xcd 0x2c 0x01)
            assert.deepStrictEqual(patch(state), [3, 10, 1 * 4 + 2, 0xcd, 0x2c, 0x01, 2]);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(Array.from(client.scores.entries()), [[5, 1], [300, 2]]);

            state.scores.set(300, 9); // REPLACE index 1
            assert.deepStrictEqual(patch(state), [3, 4, 1 * 4 + 0, 9]);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.strictEqual(client.scores.get(300), 9);

            state.scores.delete(5); // DELETE index 0
            assert.deepStrictEqual(patch(state), [3, 2, 0 * 4 + 1]);
            client.decode(getEncoder(state).encode());
            assert.deepStrictEqual(Array.from(client.scores.keys()), [300]);
        });

        it("a fixed-width key type uses that primitive's writer", () => {
            class State extends Schema {
                @type({ map: "number", key: "uint8" }) scores = new MapSchema<number, number>();
            }
            const state = new State();
            state.scores.set(200, 1);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(Array.from(client.scores.entries()), [[200, 1]]);

            state.scores.set(7, 2);
            assert.deepStrictEqual(patch(state), [3, 6, 1 * 4 + 2, 7, 2]);
            client.decode(getEncoder(state).encode());
            assert.deepStrictEqual(Array.from(client.scores.keys()), [200, 7]);
        });

        it("replacing a Schema child goes out as ADD; the decoder derives DELETE_AND_ADD", () => {
            class State extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
            }
            const state = new State();
            state.items.set("k", item("one"));
            const client = bootstrap(state);
            const first = client.items.get("k");

            const removed: string[] = [];
            const added: string[] = [];
            getCallbacks(client)(client).items.onRemove((v) => removed.push(v.name));
            getCallbacks(client)(client).items.onAdd((v) => added.push(v.name), false);

            state.items.set("k", item("two")); // recorder: DELETE_AND_ADD
            const bytes = patch(state);
            assert.strictEqual(bytes[2], 0 * 4 + 2, "ADD code on the wire, no DELETE_AND_ADD");
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(removed, ["one"]);
            assert.deepStrictEqual(added, ["two"]);
            assert.notStrictEqual(client.items.get("k"), first);
            assertRefIdCounts(state, client);

            // same-tick delete + re-set of the same instance: nothing to report
            const two = state.items.get("k");
            state.items.delete("k");
            state.items.set("k", two);
            client.decode(getEncoder(state).encode());
            getEncoder(state).discardChanges();
            assert.deepStrictEqual(removed, ["one"]);
            assert.deepStrictEqual(added, ["two"]);
            assertRefIdCounts(state, client);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a SetSchema op carries no key", () => {
            class State extends Schema {
                @type({ set: "number" }) nums = new SetSchema<number>();
            }
            const state = new State();
            state.nums.add(1);
            const client = bootstrap(state);

            state.nums.add(2); // index 1
            assert.deepStrictEqual(patch(state), [3, 4, 1 * 4 + 2, 2]);
            client.decode(getEncoder(state).encode());
            assert.deepStrictEqual(client.nums.toJSON(), [1, 2]);
        });

        it("full sync body: count, then { index key value } per entry", () => {
            class State extends Schema {
                @type({ map: "number", key: "number" }) scores = new MapSchema<number, number>();
            }
            const state = new State();
            state.scores.set(1, 10);
            state.scores.set(2, 20);
            state.scores.delete(1);
            getEncoder(state).encode();
            getEncoder(state).discardChanges();
            // root chunk: [header refId0*2+1 = 1][len*2 = 12] field0 ADD=0x02, refValue refId1+body=0x06, count=1, index=1, key=2, value=20
            assert.deepStrictEqual(Array.from(state.encodeAll()), [1, 12, 0x02, 0x06, 1, 1, 2, 20]);
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    it("SetSchema: O(1) has / delete and same-tick add + delete", () => {
        class State extends Schema {
            @type({ set: Item }) items = new SetSchema<Item>();
        }
        const state = new State();
        const a = item("a"), b = item("b");
        state.items.add(a);
        state.items.add(b);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        assert.strictEqual(state.items.has(b), true);
        assert.strictEqual(state.items.add(b), false, "duplicates are rejected");
        state.items.delete(b);
        assert.strictEqual(state.items.has(b), false);
        const c = item("c");
        state.items.add(c);
        state.items.delete(c);
        client.decode(state.encode());
        assert.deepStrictEqual(client.items.toJSON(), [{ name: "a" }]);
        assertRefIdCounts(state, client);
        assertDeepStrictEqualEncodeAll(state);
    });
});
