import * as assert from "assert";
import { schema, t, StateView, StreamSchema, SchemaType } from "../src";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

const Pickup = schema({ rank: t.number() }, "NSPickup");
const Player = schema({ x: t.number() }, "NSPlayer");
type PickupT = SchemaType<typeof Pickup>;

function captureWarn<T>(fn: () => T): { result: T, warnings: string[] } {
    const warnings: string[] = [];
    const real = console.warn;
    console.warn = (...a: any[]) => warnings.push(a.map(String).join(" "));
    try { return { result: fn(), warnings }; } finally { console.warn = real; }
}

describe("subscribe(collection, priority) on non-stream structures", () => {

    it("t.map(X).stream() honours the per-view priority", () => {
        const State = schema({ pickups: t.map(Pickup).stream() }, "NSMapState");
        const state: any = new State();
        state.pickups.maxPerTick = 2;
        const encoder = getEncoder(state);
        for (let i = 0; i < 6; i++) state.pickups.set(`p${i}`, new Pickup().assign({ rank: i }));

        const client: any = createClientWithView(state);
        client.view.subscribe(state.pickups, (p: PickupT) => p.rank);   // highest rank first

        encodeMultiple(encoder, state, [client]);
        const ranks = Array.from(client.state.pickups.values()).map((p: any) => p.rank).sort((a, b) => a - b);
        assert.deepStrictEqual(ranks, [4, 5], "top-2 by rank, not insertion order");
    });

    it("t.set(X).stream() honours the per-view priority", () => {
        const State = schema({ loot: t.set(Pickup).stream() }, "NSSetState");
        const state: any = new State();
        state.loot.maxPerTick = 2;
        const encoder = getEncoder(state);
        for (let i = 0; i < 6; i++) state.loot.add(new Pickup().assign({ rank: i }));

        const client: any = createClientWithView(state);
        client.view.subscribe(state.loot, (p: PickupT) => p.rank);

        encodeMultiple(encoder, state, [client]);
        const ranks = Array.from(client.state.loot.values()).map((p: any) => p.rank).sort((a, b) => a - b);
        assert.deepStrictEqual(ranks, [4, 5]);
    });

    it("plain t.map(X): warns, ignores the callback, still subscribes", () => {
        const State = schema({ players: t.map(Player) }, "NSPlainState");
        const state: any = new State();
        const encoder = getEncoder(state);
        for (let i = 0; i < 4; i++) state.players.set(`p${i}`, new Player().assign({ x: i }));

        const client: any = createClientWithView(state);
        let called = 0;
        const { warnings } = captureWarn(() =>
            client.view.subscribe(state.players, () => { called++; return 0; }));

        assert.match(warnings[0], /`priority` ignored/);
        assert.match(warnings[0], /NSPlainState#players is a MapSchema/,
            "names the offending field, not a dump of the collection");
        assert.ok(!warnings[0].includes("$items"), "must not inspect the collection internals");
        assert.strictEqual(warnings[0].split("\n").length, 1, "stays a single line");

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.players.size, 4, "subscription still delivered everything");
        assert.strictEqual(called, 0, "callback never invoked");
    });

    it("plain t.set(X): same treatment", () => {
        const State = schema({ bag: t.set(Pickup) }, "NSPlainSet");
        const state: any = new State();
        const encoder = getEncoder(state);
        for (let i = 0; i < 3; i++) state.bag.add(new Pickup().assign({ rank: i }));

        const client: any = createClientWithView(state);
        const { warnings } = captureWarn(() => client.view.subscribe(state.bag, () => 0));
        assert.match(warnings[0], /NSPlainSet#bag is a SetSchema/);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.bag.size, 3);
    });

    it("no stream state is allocated for the ignored case", () => {
        const State = schema({ players: t.map(Player) }, "NSNoAlloc");
        const state: any = new State();
        const client: any = createClientWithView(state);
        captureWarn(() => client.view.subscribe(state.players, () => 0));
        assert.strictEqual(state.players._stream, undefined,
            "a rejected priority must not allocate streaming bookkeeping");
    });

    it("an unattached StreamSchema: guard keys on the tree flag", () => {
        // `isStreamCollection` is inherited when the field is attached to a
        // parent. A bare StreamSchema has never been attached, so the guard
        // cannot know it is a stream yet.
        const bare = new StreamSchema<PickupT>();
        const view = new StateView();
        const { warnings } = captureWarn(() => view.subscribe(bare, () => 0));
        assert.match(warnings[0], /not attached to a state yet/,
            "distinct message: the cause is attachment, not the collection type");
        assert.strictEqual((bare as any)._stream, undefined);
    });

    it("subscribing after attachment works for the same instance", () => {
        const State = schema({ pickups: t.stream(Pickup) }, "NSReattach");
        const state: any = new State();
        state.pickups.maxPerTick = 2;
        const encoder = getEncoder(state);
        for (let i = 0; i < 6; i++) state.pickups.add(new Pickup().assign({ rank: i }));

        const client: any = createClientWithView(state);
        const { warnings } = captureWarn(() =>
            client.view.subscribe(state.pickups, (p: PickupT) => p.rank));
        assert.deepStrictEqual(warnings, [], "no warning once attached");

        encodeMultiple(encoder, state, [client]);
        const ranks = client.state.pickups.toArray().map((p: any) => p.rank).sort((a: number, b: number) => a - b);
        assert.deepStrictEqual(ranks, [4, 5]);
    });
});
