import * as assert from "assert";
import { Schema, type, view, MapSchema, schema, t, Metadata, type SchemaType } from "../src";
import { Callbacks } from "../src/decoder/strategy/Callbacks";
import { $keyType } from "../src/types/symbols";
import {
    createInstanceFromReflection, assertDeepStrictEqualEncodeAll, assertRefIdCounts, assertNoOrphanRefs,
    getEncoder, getDecoder, getCallbacks, createClientWithView, encodeMultiple,
} from "./Schema";

class Item extends Schema {
    @type("string") name: string;
    @type("number") price: number = 0;
}

function item(name: string, price = 0) {
    return new Item().assign({ name, price });
}

class State extends Schema {
    @type({ map: Item, key: "number" }) byId = new MapSchema<Item, number>();
    @type({ map: "number", key: "number" }) scores = new MapSchema<number, number>();
    @type({ map: Item }) byName = new MapSchema<Item>();
}

function join<T extends Schema>(state: T): T {
    const client = createInstanceFromReflection(state);
    client.decode(getEncoder(state).encodeAll());
    getEncoder(state).discardChanges();
    return client;
}

function captureWarnings(fn: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.map(String).join(" "));
    try { fn(); } finally { console.warn = original; }
    return warnings;
}

describe("MapSchema: number keys", () => {

    it("keys are numbers on both sides (negative and fractional included); JSON keys are strings", () => {
        const state = new State();
        state.scores.set(1, 10);
        state.scores.set(-2, 20);
        state.scores.set(1.5, 30);
        state.byId.set(42, item("answer"));

        assert.deepStrictEqual(Array.from(state.scores.keys()), [1, -2, 1.5]);
        assert.strictEqual(state.scores.get(-2), 20);
        assert.strictEqual(state.scores.has(1.5), true);
        assert.strictEqual(state.byId.get(42).name, "answer");

        const client = join(state);
        assert.deepStrictEqual(Array.from(client.scores.entries()), [[1, 10], [-2, 20], [1.5, 30]]);
        assert.deepStrictEqual(Array.from(client.byId.keys()), [42]);
        assert.strictEqual(client.byId.get(42).name, "answer");
        assert.deepStrictEqual(client.toJSON(), { byId: { "42": { name: "answer", price: 0 } }, scores: { "1": 10, "-2": 20, "1.5": 30 }, byName: {} });

        state.scores.delete(-2);
        state.scores.set(1, 11);
        state.byId.set(7, item("seven"));
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(Array.from(client.scores.entries()), [[1, 11], [1.5, 30]]);
        assert.deepStrictEqual(Array.from(client.byId.keys()), [42, 7]);
        assertRefIdCounts(state, client);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("string keys are coerced on a number-keyed map; non-numeric keys throw", () => {
        const state = new State();
        state.scores.set("3" as any, 1);
        assert.deepStrictEqual(Array.from(state.scores.keys()), [3]);
        assert.strictEqual(state.scores.get(3), 1);
        assert.throws(() => state.scores.set("abc" as any, 1), /not a valid number key/);
        assert.throws(() => state.byId.set(NaN, item("x")), /not a valid number key/);

        // a string-keyed map still stringifies numbers (legacy behavior)
        state.byName.set(5 as any, item("five"));
        assert.deepStrictEqual(Array.from(state.byName.keys()), ["5"]);
    });

    it("callbacks receive number keys", () => {
        const state = new State();
        state.byId.set(1, item("one"));
        state.scores.set(10, 100);
        const client = join(state);
        const callbacks = Callbacks.get(getDecoder(client));

        const added: Array<[string, any]> = [];
        const removed: Array<[string, any]> = [];
        const changed: Array<[any, any]> = [];
        callbacks.onAdd("byId", (value, key) => added.push([value.name, key]), false);
        callbacks.onRemove("byId", (value, key) => removed.push([value.name, key]));
        callbacks.onChange("scores", (key, value) => changed.push([key, value]));

        state.byId.set(2, item("two"));
        state.byId.delete(1);
        state.scores.set(10, 101);
        state.scores.set(11, 111);
        client.decode(getEncoder(state).encode());

        assert.deepStrictEqual(added, [["two", 2]]);
        assert.deepStrictEqual(removed, [["one", 1]]);
        assert.deepStrictEqual(changed, [[10, 101], [11, 111]]);
        assert.strictEqual(typeof added[0][1], "number");
        assert.strictEqual(typeof removed[0][1], "number");

        // legacy `$()` proxy style too
        const $ = getCallbacks(client);
        const seen: number[] = [];
        $(client).byId.onAdd((_, key) => seen.push(key), true);
        assert.deepStrictEqual(seen, [2]);
    });

    it("clone() keeps numeric keys and the key type", () => {
        const state = new State();
        state.byId.set(3, item("three"));
        state.scores.set(4, 40);
        const cloned = state.clone();
        assert.deepStrictEqual(Array.from(cloned.byId.keys()), [3]);
        assert.deepStrictEqual(Array.from(cloned.scores.keys()), [4]);
        assert.strictEqual(cloned.byId[$keyType], "number");
        assert.notStrictEqual(cloned.byId.get(3), state.byId.get(3));
        assert.strictEqual(cloned.byId.get(3).name, "three");
        assert.deepStrictEqual(cloned.toJSON(), state.toJSON());
    });

    it("a map populated before it is attached to the field is re-keyed on attach", () => {
        const state = new State();
        const detached = new MapSchema<number, number>();
        detached.set(1, 10); // no key type yet → stored as "1"
        assert.deepStrictEqual(Array.from(detached.keys()), ["1" as any]);

        state.scores = detached;
        assert.deepStrictEqual(Array.from(state.scores.keys()), [1]);
        assert.strictEqual(state.scores.indexByKey.get(1), 0);
        assert.strictEqual(state.scores.keyByIndex.get(0), 1);

        // plain object / Map assignment converts with numeric keys
        state.byId = { 5: item("five"), 6: item("six") } as any;
        assert.deepStrictEqual(Array.from(state.byId.keys()), [5, 6]);
        state.scores = new Map([[7, 70]]) as any;
        assert.deepStrictEqual(Array.from(state.scores.keys()), [7]);

        // constructor initial values on a number-keyed field
        state.scores = new MapSchema<number, number>({ 8: 80, 9: 90 } as any);
        assert.deepStrictEqual(Array.from(state.scores.keys()), [8, 9]);

        const client = join(state);
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual(Array.from(client.byId.keys()), [5, 6]);
        assert.deepStrictEqual(Array.from(client.scores.keys()), [8, 9]);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("builder form: t.map(X, { key: \"number\" })", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const S = schema({
            byId: t.map(Entity, { key: "number" }),
            scores: t.map("number", { key: "int32" }),
            byName: t.map(Entity),
        }, "S");
        const state: SchemaType<typeof S> = new S();
        state.byId.set(100, new Entity().assign({ id: 100 }));
        state.scores.set(-5, 1);
        state.byName.set("n", new Entity().assign({ id: 1 }));

        const metadata = Metadata.initialize(S);
        assert.strictEqual(metadata[metadata.byId].type.key, "number");
        assert.strictEqual(metadata[metadata.scores].type.key, "int32");
        assert.strictEqual(metadata[metadata.byName].type.key, undefined);

        const client = join(state);
        assert.deepStrictEqual(Array.from(client.byId.keys()), [100]);
        assert.deepStrictEqual(Array.from(client.scores.entries()), [[-5, 1]]);
        assert.deepStrictEqual(Array.from(client.byName.keys()), ["n"]);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("rejects an invalid key type or a key on a non-map field", () => {
        assert.throws(() => {
            class Bad extends Schema {
                @type({ map: "number", key: "boolean" as any }) m = new MapSchema<number, number>();
            }
            return Bad;
        }, /invalid map key type "boolean"/);
        assert.throws(() => {
            class Bad extends Schema {
                @type({ set: "number", key: "number" } as any) s: any;
            }
            return Bad;
        }, /'key' is only valid on map fields/);
    });

    it("key order in the declaration does not matter", () => {
        class S extends Schema {
            @type({ key: "number", map: Item } as any) byId = new MapSchema<Item, number>();
        }
        const state = new S();
        state.byId.set(9, item("nine"));
        const client = join(state);
        assert.deepStrictEqual(Array.from(client.byId.keys()), [9]);
        assert.strictEqual(client.byId.get(9).name, "nine");
    });

    it("same-tick delete + re-set, clear + add, and a mid-tick joiner", () => {
        const state = new State();
        state.byId.set(1, item("one"));
        state.byId.set(2, item("two"));
        const client = join(state);

        state.byId.delete(1);
        state.byId.set(1, item("uno"));
        state.scores.set(5, 50);
        const late = createInstanceFromReflection(state);
        late.decode(getEncoder(state).encodeAll());
        state.scores.set(6, 60);
        const patch = getEncoder(state).encode();
        client.decode(patch);
        late.decode(patch);
        getEncoder(state).discardChanges();

        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual(late.toJSON(), state.toJSON());
        assert.strictEqual(client.byId.get(1).name, "uno");
        assertRefIdCounts(state, client);
        assertRefIdCounts(state, late);

        state.byId.clear();
        state.byId.set(3, item("three"));
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(Array.from(client.byId.keys()), [3]);
        assertRefIdCounts(state, client);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("@view() filtered number-keyed map sends each client its own entries", () => {
        class S extends Schema {
            @view() @type({ map: Item, key: "number" }) items = new MapSchema<Item, number>();
        }
        const state = new S();
        const encoder = getEncoder(state);
        state.items.set(1, item("a"));
        state.items.set(2, item("b"));

        const client1 = createClientWithView(state);
        const client2 = createClientWithView(state);
        client1.view.add(state.items.get(1));
        client2.view.add(state.items.get(2));
        encodeMultiple(encoder, state, [client1, client2]);
        assert.deepStrictEqual(Array.from(client1.state.items.keys()), [1]);
        assert.deepStrictEqual(Array.from(client2.state.items.keys()), [2]);

        state.items.get(1).price = 5;
        state.items.delete(2);
        encodeMultiple(encoder, state, [client1, client2]);
        assert.strictEqual(client1.state.items.get(1).price, 5);
        assert.deepStrictEqual(Array.from(client2.state.items.keys()), []);
    });

    it("resync sweep prunes by numeric key", () => {
        const state = new State();
        state.byId.set(1, item("one"));
        state.byId.set(2, item("two"));
        state.scores.set(10, 1);
        state.scores.set(20, 2);
        const client = join(state);

        const removed: Array<[any, number]> = [];
        const callbacks = Callbacks.get(getDecoder(client));
        callbacks.onRemove("byId", (v, k) => removed.push([v.name, k]));
        callbacks.onRemove("scores", (v, k) => removed.push([v, k]));

        // offline: the DELETE patches are never delivered
        state.byId.delete(2);
        state.scores.delete(10);
        getEncoder(state).encode();
        getEncoder(state).discardChanges();

        const warnings = captureWarnings(() => getDecoder(client).decodeResync(getEncoder(state).encodeAll()));
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual(Array.from(client.byId.keys()), [1]);
        assert.deepStrictEqual(Array.from(client.scores.keys()), [20]);
        assert.deepStrictEqual(removed, [["two", 2], [1, 10]]);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it(".stream() map with number keys", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const S = schema({ entities: t.map(Entity, { key: "number" }).stream() }, "S");
        const state: SchemaType<typeof S> = new S();
        state.entities.maxPerTick = 2;
        const decoded: SchemaType<typeof S> = new S();
        decoded.decode(getEncoder(state).encodeAll());

        for (let i = 0; i < 3; i++) state.entities.set(i * 10, new Entity().assign({ id: i }));
        decoded.decode(getEncoder(state).encode());
        assert.deepStrictEqual(Array.from(decoded.entities.keys()), [0, 10]);
        decoded.decode(getEncoder(state).encode());
        assert.deepStrictEqual(Array.from(decoded.entities.keys()), [0, 10, 20]);

        state.entities.delete(10);
        decoded.decode(getEncoder(state).encode());
        assert.deepStrictEqual(Array.from(decoded.entities.keys()), [0, 20]);
    });

    it("fixed-width key types: int32 / uint8 / float64", () => {
        class S extends Schema {
            @type({ map: "string", key: "int32" }) i32 = new MapSchema<string, number>();
            @type({ map: "string", key: "uint8" }) u8 = new MapSchema<string, number>();
            @type({ map: "string", key: "float64" }) f64 = new MapSchema<string, number>();
        }
        const state = new S();
        state.i32.set(-123456, "a");
        state.u8.set(255, "b");
        state.f64.set(0.1, "c");
        const client = join(state);
        assert.deepStrictEqual(Array.from(client.i32.entries()), [[-123456, "a"]]);
        assert.deepStrictEqual(Array.from(client.u8.entries()), [[255, "b"]]);
        assert.deepStrictEqual(Array.from(client.f64.entries()), [[0.1, "c"]]);

        state.i32.set(-123456, "aa");
        state.u8.delete(255);
        state.f64.set(2.5, "d");
        client.decode(getEncoder(state).encode());
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual(Array.from(client.f64.keys()), [0.1, 2.5]);
    });

    it("moving an instance between numeric keys in one tick keeps identity", () => {
        const state = new State();
        state.byId.set(1, item("one"));
        const client = join(state);
        const before = client.byId.get(1);

        state.byId.set(2, state.byId.get(1));
        state.byId.delete(1);
        client.decode(getEncoder(state).encode());
        getEncoder(state).discardChanges();

        assert.deepStrictEqual(Array.from(client.byId.keys()), [2]);
        assert.strictEqual(client.byId.get(2), before);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
        assertDeepStrictEqualEncodeAll(state);
    });
});
