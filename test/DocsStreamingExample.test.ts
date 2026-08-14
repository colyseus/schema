/**
 * Executable check of the code published on docs.colyseus.io/state/streaming.
 *
 * Every snippet on that page is reproduced here as literally as the test
 * harness allows, so a failure means the docs went stale. The `describe`
 * blocks track the page's section headings — when a section moves or its
 * claims change, update the matching block.
 */
import * as assert from "assert";
import { schema, t, StateView, SchemaType } from "../src";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

// ─── "At a glance" — the published schema, verbatim ─────────────────────
const Player = schema({ x: t.number(), y: t.number() }, "Player");
const Enemy = schema({ x: t.number(), y: t.number() }, "Enemy");

const MyState = schema({
    players: t.map(Player),
    enemies: t.stream(Enemy),
}, "MyState");

type MyStateT = SchemaType<typeof MyState>;
type PlayerT = SchemaType<typeof Player>;
type EnemyT = SchemaType<typeof Enemy>;

const dist2 = (a: { x: number, y: number }, b: { x: number, y: number }) =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

const xs = (client: any) =>
    client.state.enemies.toArray()
        .map((e: EnemyT) => e.x)
        .sort((a: number, b: number) => a - b);

/**
 * 12 enemies along x = 0,10..110, plus two players at opposite ends —
 * the shape the page's proximity example implies.
 */
function scenario(maxPerTick = 4) {
    const state: MyStateT = new MyState();
    state.enemies.maxPerTick = maxPerTick;
    const encoder = getEncoder(state);

    const near: PlayerT = new Player().assign({ x: 0, y: 0 });
    const far: PlayerT = new Player().assign({ x: 110, y: 0 });
    state.players.set("near", near);
    state.players.set("far", far);

    for (let i = 0; i < 12; i++) {
        state.enemies.add(new Enemy().assign({ x: i * 10, y: 0 }));
    }
    return { state, encoder, near, far };
}

/** The page's `onJoin` body. */
function join(state: MyStateT, player: PlayerT) {
    const client: any = createClientWithView(state);
    client.view.subscribe(state.enemies, (enemy: EnemyT) =>
        -((enemy.x - player.x) ** 2 + (enemy.y - player.y) ** 2));
    return client;
}

describe("docs /state/streaming", () => {

    describe("At a glance", () => {
        it("the three pieces work together as published", () => {
            const { state, encoder, near, far } = scenario(8);

            // "maxPerTick caps how fast it drains"
            assert.strictEqual(state.enemies.maxPerTick, 8);

            // "subscribe() connects one client to it, with an optional
            //  callback that orders that client's backlog"
            const nearClient = join(state, near);
            const farClient = join(state, far);

            encodeMultiple(encoder, state, [nearClient, farClient]);

            assert.strictEqual(nearClient.state.enemies.length, 8);
            assert.deepStrictEqual(xs(nearClient), [0, 10, 20, 30, 40, 50, 60, 70],
                "nearest first, for the client at x=0");
            assert.deepStrictEqual(xs(farClient), [40, 50, 60, 70, 80, 90, 100, 110],
                "nearest first, for the client at x=110");
        });

        it("field changes on delivered entries don't consume the budget", () => {
            const { state, encoder, near } = scenario(4);
            const client = join(state, near);

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 4);

            const delivered = state.enemies.toArray().find((e: EnemyT) => e.x === 0)!;
            delivered.y = 999;

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 8,
                "a full budget of 4 new additions still arrived alongside the patch");
            const patched = client.state.enemies.toArray().find((e: any) => e.x === 0);
            assert.strictEqual(patched.y, 999);
        });
    });

    describe("`t.stream(Entity)`", () => {
        it("positions stay stable when other entries are removed", () => {
            const state: MyStateT = new MyState();
            const a: EnemyT = new Enemy().assign({ x: 1, y: 1 });
            const b: EnemyT = new Enemy().assign({ x: 2, y: 2 });
            state.enemies.add(a);
            state.enemies.add(b);

            state.enemies.remove(a);

            const seen: any[] = [];
            state.enemies.forEach((v: EnemyT, position: number) => seen.push([v.x, position]));
            assert.deepStrictEqual(seen, [[2, 1]], "b keeps position 1, it does not shift to 0");
        });

        it("primitives are a TypeScript error, with no runtime check", () => {
            // The page says exactly this: `t.stream("number")` is TS2345, and
            // "no runtime check enforces it — plain JavaScript gets no diagnostic".
            assert.doesNotThrow(() => schema({ nums: t.stream("number" as any) }, "PrimState"));
        });

        describe("`StreamSchema` API table", () => {
            it("matches the published signatures", () => {
                const state: MyStateT = new MyState();
                const a: EnemyT = new Enemy().assign({ x: 1, y: 1 });
                const b: EnemyT = new Enemy().assign({ x: 2, y: 2 });

                assert.strictEqual(state.enemies.add(a), 0, "returns its wire position");
                assert.strictEqual(state.enemies.add(b), 1);
                assert.strictEqual(state.enemies.add(a), -1, "or -1 if already present");

                assert.strictEqual(state.enemies.has(b), true);
                assert.strictEqual(state.enemies.remove(a), true, "returns whether it was present");
                assert.strictEqual(state.enemies.remove(a), false);

                assert.strictEqual(state.enemies.size, 1);
                assert.strictEqual(state.enemies.length, 1);
                assert.deepStrictEqual(state.enemies.toArray().map((e: EnemyT) => e.x), [2]);
                assert.deepStrictEqual([...state.enemies.values()].map((e: EnemyT) => e.x), [2]);
                assert.deepStrictEqual([...state.enemies.entries()].map(([p]) => p), [1]);

                state.enemies.clear();
                assert.strictEqual(state.enemies.size, 0);
            });

            it("forEach yields (value, position, stream)", () => {
                const state: MyStateT = new MyState();
                state.enemies.add(new Enemy().assign({ x: 7, y: 0 }));
                state.enemies.forEach((value: EnemyT, position: number, stream: any) => {
                    assert.strictEqual(value.x, 7);
                    assert.strictEqual(position, 0);
                    assert.strictEqual(stream, state.enemies);
                });
            });

            it("maxPerTick defaults to 32", () => {
                assert.strictEqual(new MyState().enemies.maxPerTick, 32);
            });
        });

        describe("Streaming an existing collection type", () => {
            it("t.map(X).stream() batches, keeping map semantics", () => {
                const Pickup = schema({ kind: t.string() }, "Pickup");
                const State = schema({ pickups: t.map(Pickup).stream() }, "PickupState");

                const state: SchemaType<typeof State> = new State();
                state.pickups.maxPerTick = 2;

                const decoded: SchemaType<typeof State> = new State();
                decoded.decode(state.encodeAll());

                for (let i = 0; i < 5; i++) {
                    state.pickups.set(`p${i}`, new Pickup().assign({ kind: `k${i}` }));
                }

                decoded.decode(state.encode());
                assert.strictEqual(decoded.pickups.size, 2);
                decoded.decode(state.encode());
                assert.strictEqual(decoded.pickups.size, 4);
                decoded.decode(state.encode());
                assert.strictEqual(decoded.pickups.size, 5);
            });

            it("t.array(X).stream() throws at definition time", () => {
                const Item = schema({ v: t.number() }, "ArrItem");
                assert.throws(
                    () => schema({ items: t.array(Item).stream() }, "ArrState"),
                    /ArraySchema does not support streaming/,
                );
            });
        });
    });

    describe("`maxPerTick`", () => {
        it("100 pending with maxPerTick=8 arrives 8 at a time", () => {
            const state: MyStateT = new MyState();
            state.enemies.maxPerTick = 8;
            const encoder = getEncoder(state);
            const player: PlayerT = new Player().assign({ x: 0, y: 0 });
            state.players.set("p", player);
            for (let i = 0; i < 100; i++) {
                state.enemies.add(new Enemy().assign({ x: i, y: 0 }));
            }

            const client = join(state, player);
            for (let tick = 1; tick <= 3; tick++) {
                encodeMultiple(encoder, state, [client]);
                assert.strictEqual(client.state.enemies.length, tick * 8, `tick ${tick}`);
            }
        });

        it("a client with 3 pending gets all 3 immediately", () => {
            const state: MyStateT = new MyState();
            state.enemies.maxPerTick = 8;
            const encoder = getEncoder(state);
            const player: PlayerT = new Player().assign({ x: 0, y: 0 });
            state.players.set("p", player);
            for (let i = 0; i < 3; i++) {
                state.enemies.add(new Enemy().assign({ x: i, y: 0 }));
            }

            const client = join(state, player);
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 3);
        });
    });

    describe("Getting entries to clients", () => {
        it("entries added AFTER a view exists need the subscription", () => {
            const state: MyStateT = new MyState();
            state.enemies.maxPerTick = 8;
            const encoder = getEncoder(state);

            const client: any = createClientWithView(state);
            client.view.add(state);   // a view exists, but never subscribes

            for (let i = 0; i < 12; i++) {
                state.enemies.add(new Enemy().assign({ x: i * 10, y: 0 }));
            }

            for (let i = 0; i < 3; i++) encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 0);
        });

        it("entries added BEFORE any view exists still broadcast to everyone", () => {
            // `onCreate` runs before anyone joins, so those additions land in
            // the broadcast backlog and reach every client regardless of
            // subscription — the reason an unsubscribed room looks like it
            // works, then silently stops delivering.
            const { state, encoder } = scenario(8);

            const client: any = createClientWithView(state);
            client.view.add(state);   // never subscribes

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 12,
                "the whole pre-join backlog, not capped by maxPerTick");
        });

        it("subscription order doesn't matter — existing entries arrive too", () => {
            const { state, encoder, near } = scenario(4);
            // entries were added before this client ever subscribed
            const client = join(state, near);

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 4);
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.enemies.length, 8);
        });
    });

    describe("Priority", () => {
        it("without a callback, entries drain in insertion order", () => {
            const state: MyStateT = new MyState();
            state.enemies.maxPerTick = 3;
            const encoder = getEncoder(state);
            for (const x of [900, 10, 800, 20, 700, 30]) {
                state.enemies.add(new Enemy().assign({ x, y: 0 }));
            }

            const client: any = createClientWithView(state);
            client.view.subscribe(state.enemies);

            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(
                client.state.enemies.toArray().map((e: EnemyT) => e.x),
                [900, 10, 800],
            );
        });

        describe("Per client", () => {
            it("the anchor is the entity, so it never goes stale", () => {
                const { state, encoder, near } = scenario(4);
                const client = join(state, near);

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);

                // "move the player and the next batch reorders"
                near.x = 110;

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110]);
            });

            it("subscribing again with a new callback retargets the ordering", () => {
                const { state, encoder, near, far } = scenario(4);
                const client = join(state, near);

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);

                client.view.subscribe(state.enemies, (enemy: EnemyT) => -dist2(enemy, far));

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110]);
            });

            it("null drops it, falling back to the field's own callback", () => {
                const State = schema({
                    players: t.map(Player),
                    enemies: t.stream(Enemy).priority((_v: any, e: any) => e.x),  // farthest first
                }, "NullFallbackState");

                const state: any = new State();
                state.enemies.maxPerTick = 4;
                const encoder = getEncoder(state);
                const near: PlayerT = new Player().assign({ x: 0, y: 0 });
                state.players.set("near", near);
                for (let i = 0; i < 12; i++) state.enemies.add(new Enemy().assign({ x: i * 10, y: 0 }));

                const client: any = createClientWithView(state);
                client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30], "per-client override");

                client.view.subscribe(state.enemies, null);

                encodeMultiple(encoder, state, [client]);
                assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110],
                    "field callback's farthest-first resumed");
            });
        });

        describe("The same order for every client", () => {
            it("a field callback orders identically for everyone", () => {
                const Threat = schema({ threatLevel: t.number() }, "Threat");
                const State = schema({
                    enemies: t.stream(Threat).priority((_view, enemy: any) => enemy.threatLevel),
                }, "ThreatState");

                const state: any = new State();
                state.enemies.maxPerTick = 2;
                const encoder = getEncoder(state);
                for (const lvl of [1, 50, 10, 99]) {
                    state.enemies.add(new Threat().assign({ threatLevel: lvl }));
                }

                const a: any = createClientWithView(state);
                a.view.subscribe(state.enemies);
                const b: any = createClientWithView(state);
                b.view.subscribe(state.enemies);

                encodeMultiple(encoder, state, [a, b]);
                const levels = (c: any) => c.state.enemies.toArray()
                    .map((e: any) => e.threatLevel).sort((x: number, y: number) => x - y);
                assert.deepStrictEqual(levels(a), [50, 99]);
                assert.deepStrictEqual(levels(b), [50, 99]);
            });

            it("a per-client callback overrides it for that client only", () => {
                const State = schema({
                    players: t.map(Player),
                    enemies: t.stream(Enemy).priority((_v: any, e: any) => e.x),  // farthest first
                }, "OverrideState");

                const state: any = new State();
                state.enemies.maxPerTick = 4;
                const encoder = getEncoder(state);
                const near: PlayerT = new Player().assign({ x: 0, y: 0 });
                state.players.set("near", near);
                for (let i = 0; i < 12; i++) state.enemies.add(new Enemy().assign({ x: i * 10, y: 0 }));

                const usingField: any = createClientWithView(state);
                usingField.view.subscribe(state.enemies);

                const usingOverride: any = createClientWithView(state);
                usingOverride.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

                encodeMultiple(encoder, state, [usingField, usingOverride]);
                assert.deepStrictEqual(xs(usingField), [80, 90, 100, 110]);
                assert.deepStrictEqual(xs(usingOverride), [0, 10, 20, 30]);
            });
        });

        it("broadcast mode drains in insertion order, ignoring priority", () => {
            const State = schema({
                enemies: t.stream(Enemy).priority((_v: any, e: any) => -e.x),
            }, "BroadcastState");

            const state: any = new State();
            state.enemies.maxPerTick = 4;

            const decoded: any = new State();
            decoded.decode(state.encodeAll());

            for (const x of [900, 10, 800, 20, 700, 30, 600, 40]) {
                state.enemies.add(new Enemy().assign({ x, y: 0 }));
            }

            decoded.decode(state.encode());
            assert.deepStrictEqual(
                decoded.enemies.toArray().map((e: EnemyT) => e.x),
                [900, 10, 800, 20],
                "insertion order — no StateView, so no per-client ordering",
            );
        });
    });
});
