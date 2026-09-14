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
        assert.deepStrictEqual(Array.from(rec.ops.keys()), [0]); // indexes restart after clear

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
