import * as assert from "assert";
import { Schema, type, view, schema, t, SetSchema, CollectionSchema, $changes, $refId } from "../src";
import type { KeyedRecorder } from "../src/encoder/KeyedRecorder";
import { createClientWithView, createInstanceFromReflection, encodeMultiple, getDecoder, getEncoder } from "./Schema";

/**
 * SetSchema / CollectionSchema reuse wire indexes the way MapSchema does
 * (docs/perf/leads/06-wire-index-recycling.md): an index whose DELETE shipped
 * is reused from the next tick on, never while a view still holds an entry
 * for it. Clients replace an occupied index on ADD (the decoder overwrite).
 */
class Item extends Schema {
    @type("number") v: number = 0;
}
class PlainState extends Schema {
    @type({ set: "number" }) nums = new SetSchema<number>();
    @type({ set: Item }) items = new SetSchema<Item>();
    @type({ collection: Item }) bag = new CollectionSchema<Item>();
}
class FilteredState extends Schema {
    @view() @type({ set: Item }) items = new SetSchema<Item>();
}

const recOf = (c: any) => c[$changes]?.rec as KeyedRecorder | undefined;
const indexOf = (c: any, value: any) => c.indexByValue.get(value) as number | undefined;
const nextIndexOf = (c: any) => c.nextIndex as number;

describe("SetSchema / CollectionSchema wire-index recycling", () => {

    describe("churn", () => {
        for (const field of ["nums", "items", "bag"] as const) {
            it(`${field}: 10 000 cycles keep nextIndex within live + churn and the client in sync`, () => {
                const state = new PlainState();
                const client = createInstanceFromReflection(state);
                const n = 100, churn = 10;
                let counter = 0;
                const make = () => (field === "nums") ? counter++ : new Item().assign({ v: counter++ });
                const live: any[] = [];
                const coll: any = state[field];
                for (let j = 0; j < n; j++) { const v = make(); live.push(v); coll.add(v); }
                client.decode(state.encode());

                let maxIndex = 0;
                for (let c = 0; c < 10_000; c++) {
                    for (let j = 0; j < churn; j++) coll.delete(live.shift());
                    client.decode(state.encode());
                    for (let j = 0; j < churn; j++) {
                        const v = make();
                        live.push(v);
                        coll.add(v);
                        maxIndex = Math.max(maxIndex, indexOf(coll, v)!);
                    }
                    client.decode(state.encode());
                }
                assert.ok(nextIndexOf(coll) <= n + churn, `nextIndex ${nextIndexOf(coll)}`);
                assert.ok(maxIndex < n + churn);
                assert.deepStrictEqual(client.toJSON(), state.toJSON());
                if (field !== "nums") {
                    assert.strictEqual(getDecoder(client).root.refs.size, getEncoder(state).root.changeTrees.size);
                }
            });
        }
    });

    describe("same tick", () => {
        it("a value added in the tick another was removed never gets the freed index", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            state.nums.add(1);
            state.nums.add(2);
            client.decode(state.encode());

            state.nums.delete(2);
            state.nums.add(3);
            assert.strictEqual(indexOf(state.nums, 3), 2, "index 1 was freed this tick");
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());

            state.nums.add(4);
            assert.strictEqual(indexOf(state.nums, 4), 1, "reused from the next tick on");
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        });

        it("a CollectionSchema reuses an index for a duplicate value", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            const a = new Item().assign({ v: 1 });
            const b = new Item().assign({ v: 2 });
            state.bag.add(a);
            state.bag.add(b);
            client.decode(state.encode());
            state.bag.delete(a);
            client.decode(state.encode());
            state.bag.add(b); // a second entry of the same instance
            assert.strictEqual(nextIndexOf(state.bag), 2);
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        });
    });

    describe("StateView", () => {
        it("a filtered set: view A saw the old occupant of an index, view B sees the new one", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            const a = new Item().assign({ v: 1 });
            state.items.add(a);
            const A = createClientWithView(state);
            const B = createClientWithView(state);
            A.view.add(a);
            encodeMultiple(encoder, state, [A, B]);
            state.items.delete(a);
            encodeMultiple(encoder, state, [A, B]);

            const x = new Item().assign({ v: 2 });
            state.items.add(x);
            assert.strictEqual(indexOf(state.items, x), 0);
            B.view.add(x);
            encodeMultiple(encoder, state, [A, B]);
            assert.strictEqual(A.state.items.size, 0);
            assert.deepStrictEqual(Array.from(B.state.items.values()).map((i) => i.v), [2]);

            x.v = 3;
            state.items.delete(x);
            encodeMultiple(encoder, state, [A, B]);
            assert.strictEqual(B.state.items.size, 0);
        });

        it("an index a skipped view still holds an entry for is quarantined, then freed", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            const a = new Item();
            state.items.add(a);
            const v = createClientWithView(state);
            v.view.add(a);
            encodeMultiple(encoder, state, [v]);
            v.view.remove(a);
            state.items.delete(a);
            encodeMultiple(encoder, state, []); // v skipped: its DELETE entry is still pending
            assert.deepStrictEqual(recOf(state.items)!.quarantine, [0]);

            const b = new Item();
            state.items.add(b);
            assert.strictEqual(indexOf(state.items, b), 1, "the quarantined index is not reused");
            encodeMultiple(encoder, state, [v]); // v drains; the quarantine is re-checked at this tick's end
            const c = new Item();
            state.items.add(c);
            assert.strictEqual(indexOf(state.items, c), 0, "freed once the view drained");
            encodeMultiple(encoder, state, [v]);
            assert.deepStrictEqual(v.state.toJSON(), { items: [] });
        });

        it("after reuse, view.add / view.remove of the removed child emit nothing", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            const a = new Item().assign({ v: 1 });
            state.items.add(a);
            const v = createClientWithView(state);
            encodeMultiple(encoder, state, [v]);
            state.items.delete(a);
            encodeMultiple(encoder, state, [v]);
            const x = new Item().assign({ v: 2 });
            state.items.add(x);
            assert.strictEqual(indexOf(state.items, x), 0);
            v.view.add(x);
            encodeMultiple(encoder, state, [v]);

            v.view.add(a); // stale: `a` no longer holds index 0
            encodeMultiple(encoder, state, [v]);
            v.view.remove(a);
            encodeMultiple(encoder, state, [v]);
            assert.deepStrictEqual(Array.from(v.state.items.values()).map((i) => i.v), [2]);
        });
    });

    describe("reconnect", () => {
        it("resync after churn leaves the client equal to the server", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            const items = [1, 2, 3].map((v) => new Item().assign({ v }));
            items.forEach((i) => state.items.add(i));
            client.decode(state.encode());
            state.items.delete(items[0]);
            state.encode(); // the client misses this patch …
            const fresh = new Item().assign({ v: 9 });
            state.items.add(fresh);
            state.encode(); // … and the reuse of index 0
            assert.strictEqual(indexOf(state.items, fresh), 0);
            getDecoder(client).decodeResync(getEncoder(state).encodeAll());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assert.strictEqual(getDecoder(client).root.refs.get(fresh[$refId]!)?.v, 9);
        });
    });

    describe("lifecycle", () => {
        it("clear() drops the free indexes; numbering continues", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            [1, 2, 3].forEach((v) => state.nums.add(v));
            client.decode(state.encode());
            state.nums.delete(2);
            client.decode(state.encode());
            assert.deepStrictEqual(recOf(state.nums)!.free, [1]);
            state.nums.clear();
            assert.strictEqual(recOf(state.nums)!.free, undefined);
            state.nums.add(5);
            assert.strictEqual(indexOf(state.nums, 5), 3);
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        });

        it("discardAllChanges never frees an index", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            [1, 2].forEach((v) => state.nums.add(v));
            client.decode(state.encode());
            state.nums.delete(1);
            state.discardAllChanges();
            assert.strictEqual(recOf(state.nums)!.free, undefined);
            state.nums.add(3);
            assert.strictEqual(indexOf(state.nums, 3), 2);
        });

        it("a streamed set keeps monotonic indexes", () => {
            const Entity = schema({ id: t.number() }, "Entity");
            const State = schema({ entities: t.set(Entity).stream() }, "State");
            const state: any = new State();
            getEncoder(state);
            const decoded: any = new State();
            decoded.decode(state.encodeAll());
            const a = new Entity().assign({ id: 1 });
            state.entities.add(a);
            state.entities.add(new Entity().assign({ id: 2 }));
            decoded.decode(state.encode());
            state.entities.delete(a);
            decoded.decode(state.encode());
            decoded.decode(state.encode());
            const c = new Entity().assign({ id: 3 });
            state.entities.add(c);
            assert.strictEqual(indexOf(state.entities, c), 2);
            assert.strictEqual(recOf(state.entities)?.free, undefined);
        });
    });
});
