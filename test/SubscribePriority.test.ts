/**
 * `view.subscribe(collection, priority)` — per-view ordering declared at
 * the point of subscription, with the client's entity captured in the
 * closure instead of attached to the view.
 */
import * as assert from "assert";
import { schema, t, StateView, SchemaType } from "../src";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

const Player = schema({ x: t.number(), y: t.number() }, "SPPlayer");
const Enemy = schema({ x: t.number(), y: t.number() }, "SPEnemy");
type PlayerT = SchemaType<typeof Player>;
type EnemyT = SchemaType<typeof Enemy>;

const dist2 = (a: any, b: any) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function scenario(State: any) {
    const state: any = new State();
    state.enemies.maxPerTick = 4;
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

const xs = (c: any) =>
    c.state.enemies.toArray().map((e: EnemyT) => e.x).sort((a: number, b: number) => a - b);

const Plain = schema({ players: t.map(Player), enemies: t.stream(Enemy) }, "SPPlain");
const Declared = schema({
    players: t.map(Player),
    // declaration-scope fallback: farthest-first
    enemies: t.stream(Enemy).priority((_v: any, e: any) => e.x),
}, "SPDeclared");

describe("view.subscribe(collection, priority)", () => {

    it("each client's closure captures its own entity", () => {
        const { state, encoder, near, far } = scenario(Plain);

        const nearClient: any = createClientWithView(state);
        nearClient.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        const farClient: any = createClientWithView(state);
        farClient.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, far));

        encodeMultiple(encoder, state, [nearClient, farClient]);
        assert.deepStrictEqual(xs(nearClient), [0, 10, 20, 30]);
        assert.deepStrictEqual(xs(farClient), [80, 90, 100, 110]);
    });

    it("the anchor is the entity — moving it reorders, no refresh call", () => {
        const { state, encoder, near } = scenario(Plain);

        const client: any = createClientWithView(state);
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);

        near.x = 110;   // move the player, touch nothing else

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110]);
    });

    it("overrides the declaration-scope callback for that client only", () => {
        const { state, encoder, near } = scenario(Declared);

        const usingDeclaration: any = createClientWithView(state);
        usingDeclaration.view.subscribe(state.enemies);

        const usingOverride: any = createClientWithView(state);
        usingOverride.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        encodeMultiple(encoder, state, [usingDeclaration, usingOverride]);
        assert.deepStrictEqual(xs(usingDeclaration), [80, 90, 100, 110], "declaration: farthest");
        assert.deepStrictEqual(xs(usingOverride), [0, 10, 20, 30], "override: nearest");
    });

    it("re-subscribing retargets the ordering", () => {
        const { state, encoder, near, far } = scenario(Plain);

        const client: any = createClientWithView(state);
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);

        // player became a spectator following the other end of the map
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, far));

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110],
            "second call took effect despite subscribe() being idempotent");
    });

    it("omitting the argument on re-subscribe keeps the existing callback", () => {
        const { state, encoder, near } = scenario(Plain);

        const client: any = createClientWithView(state);
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));
        client.view.subscribe(state.enemies);   // no-op, must not clear

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);
    });

    it("null drops the override and falls back to the declaration", () => {
        const { state, encoder, near } = scenario(Declared);

        const client: any = createClientWithView(state);
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30]);

        client.view.subscribe(state.enemies, null);

        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(xs(client), [0, 10, 20, 30, 80, 90, 100, 110],
            "declaration's farthest-first resumed");
    });

    it("priority on a non-streaming collection warns but still subscribes", () => {
        const { state, encoder } = scenario(Plain);

        const client: any = createClientWithView(state);
        const warnings: string[] = [];
        const realWarn = console.warn;
        console.warn = (...a: any[]) => warnings.push(a.map(String).join(" "));
        try {
            client.view.subscribe(state.players, () => 0);
        } finally {
            console.warn = realWarn;
        }

        assert.match(warnings[0], /SPPlain#players is a MapSchema/);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.players.size, 2, "subscription itself still took effect");
    });

    it("dropping a view releases its callback", () => {
        const { state, near } = scenario(Plain);

        const client: any = createClientWithView(state);
        client.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));

        const st = (state.enemies as any)._stream;
        assert.strictEqual(st.priorityByView.size, 1);

        const viewId = client.view.id;
        client.view.dispose();
        (state.enemies as any)._dropView(viewId);
        assert.strictEqual(st.priorityByView.size, 0, "no leak across client churn");
    });

    it("two views, one entity each, stay independent after both move", () => {
        const { state, encoder, near, far } = scenario(Plain);

        const a: any = createClientWithView(state);
        a.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, near));
        const b: any = createClientWithView(state);
        b.view.subscribe(state.enemies, (e: EnemyT) => -dist2(e, far));

        encodeMultiple(encoder, state, [a, b]);
        assert.deepStrictEqual(xs(a), [0, 10, 20, 30]);
        assert.deepStrictEqual(xs(b), [80, 90, 100, 110]);

        // move both — each closure must follow its own entity, and the two
        // must diverge (same destination would make this assertion hollow)
        near.x = 60;
        far.x = 0;

        encodeMultiple(encoder, state, [a, b]);
        assert.deepStrictEqual(xs(a), [0, 10, 20, 30, 40, 50, 60, 70],
            "a drained toward x=60");
        assert.deepStrictEqual(xs(b), [0, 10, 20, 30, 80, 90, 100, 110],
            "b drained toward x=0");
    });

});
