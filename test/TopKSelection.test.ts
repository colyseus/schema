import * as assert from "assert";
import { schema, t, SchemaType } from "../src";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

const E = schema({ id: t.number(), band: t.number() }, "TopKE");
type ET = SchemaType<typeof E>;

function make(priorityFn: any, maxPerTick: number, items: Array<{id: number, band: number}>) {
    const State = schema({
        items: t.stream(E).priority(priorityFn),
    }, `TopK_${maxPerTick}_${items.length}_${Math.trunc(items[0]?.band ?? 0)}`);
    const state: any = new State();
    state.items.maxPerTick = maxPerTick;
    const encoder = getEncoder(state);
    for (const it of items) state.items.add(new E().assign(it));
    const client: any = createClientWithView(state);
    client.view.subscribe(state.items);
    return { state, encoder, client };
}

const ids = (c: any) => c.state.items.toArray().map((e: ET) => e.id);

describe("top-k selection edge cases", () => {
    it("ties drain in insertion order (stable)", () => {
        // every element scores 0 — pure tie
        const items = Array.from({ length: 10 }, (_, i) => ({ id: i, band: 0 }));
        const { state, encoder, client } = make(() => 0, 4, items);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client).sort((a: number, b: number) => a - b), [0, 1, 2, 3]);
        void state;
    });

    it("ties WITHIN a band keep insertion order, bands still ranked", () => {
        // band 1 scores higher; ids 5..9 are band 1, inserted after 0..4
        const items = Array.from({ length: 10 }, (_, i) => ({ id: i, band: i >= 5 ? 1 : 0 }));
        const { state, encoder, client } = make((_v: any, e: ET) => e.band, 3, items);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client).sort((a: number, b: number) => a - b), [5, 6, 7],
            "highest band first, earliest insertion within the band");
        void state;
    });

    it("backlog smaller than maxPerTick delivers everything", () => {
        const items = Array.from({ length: 3 }, (_, i) => ({ id: i, band: i }));
        const { state, encoder, client } = make((_v: any, e: ET) => e.band, 8, items);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client).sort((a: number, b: number) => a - b), [0, 1, 2]);
        void state;
    });

    it("strictly descending scores select the true top-k", () => {
        const items = Array.from({ length: 50 }, (_, i) => ({ id: i, band: i }));
        const { state, encoder, client } = make((_v: any, e: ET) => e.band, 5, items);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client).sort((a: number, b: number) => a - b), [45, 46, 47, 48, 49]);
        void state;
    });

    it("ascending insertion with descending priority (worst case for the window)", () => {
        // best element arrives last — the window must evict all the way down
        const items = Array.from({ length: 50 }, (_, i) => ({ id: i, band: i }));
        const { state, encoder, client } = make((_v: any, e: ET) => e.band, 1, items);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client), [49]);
        void state;
    });

    it("NaN scores don't crash and still respect the budget", () => {
        const items = Array.from({ length: 10 }, (_, i) => ({ id: i, band: i }));
        const { state, encoder, client } = make((v: any, e: ET) => e.band - v.missing, 4, items);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.items.length, 4);
        void state;
    });

    it("removing a queued element mid-backlog doesn't consume budget", () => {
        const items = Array.from({ length: 10 }, (_, i) => ({ id: i, band: i }));
        const { state, encoder, client } = make((_v: any, e: ET) => e.band, 3, items);
        const doomed = state.items.toArray().find((e: ET) => e.id === 9);
        state.items.remove(doomed);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(ids(client).sort((a: number, b: number) => a - b), [6, 7, 8],
            "full budget of 3 still delivered");
    });
});
