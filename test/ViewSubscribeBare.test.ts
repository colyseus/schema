import * as assert from "assert";
import { schema, t, StateView, Encoder } from "../src";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

describe("StateView#subscribe without a prior add()", () => {
    const Enemy = schema({ hp: t.number() }, "Enemy");
    const kinds = {
        map: () => schema({ enemies: t.map(Enemy).view() }, "StateMap"),
        array: () => schema({ enemies: t.array(Enemy).view() }, "StateArray"),
        set: () => schema({ enemies: t.set(Enemy).view() }, "StateSet"),
        collection: () => schema({ enemies: t.collection(Enemy).view() }, "StateCollection"),
    } as const;

    function put(kind: string, coll: any, e: any, key: string) {
        if (kind === "map") coll.set(key, e);
        else if (kind === "array") coll.push(e);
        else coll.add(e);
    }
    function size(kind: string, coll: any) {
        return kind === "array" ? coll?.length : coll?.size;
    }

    for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
        for (const when of ["before", "after"] as const) {
            it(`${kind}: delivers present and future items (subscribe ${when} first encode)`, () => {
                const State = kinds[kind]();
                const state = new State();
                const encoder = getEncoder(state);
                put(kind, state.enemies, new Enemy().assign({ hp: 1 }), "a");
                put(kind, state.enemies, new Enemy().assign({ hp: 2 }), "b");

                const client = createClientWithView(state, new StateView());
                if (when === "before") client.view.subscribe(state.enemies);
                encodeMultiple(encoder, state, [client]);
                if (when === "after") {
                    client.view.subscribe(state.enemies);
                    encodeMultiple(encoder, state, [client]);
                }
                assert.strictEqual(size(kind, client.state.enemies), 2);

                put(kind, state.enemies, new Enemy().assign({ hp: 3 }), "c");
                encodeMultiple(encoder, state, [client]);
                assert.strictEqual(size(kind, client.state.enemies), 3);
                const hps = Array.from((client.state.enemies as any).values()).map((e: any) => e.hp).sort();
                assert.deepStrictEqual(hps, [1, 2, 3]);
            });
        }

        it(`${kind}: one subscribe() on a shared view covers a late-joining client`, () => {
            const State = kinds[kind]();
            const state = new State();
            const encoder = getEncoder(state);
            put(kind, state.enemies, new Enemy().assign({ hp: 1 }), "a");

            const view = new StateView();
            view.subscribe(state.enemies);
            const c1 = createClientWithView(state, view);
            encodeMultiple(encoder, state, [c1]);
            assert.strictEqual(size(kind, c1.state.enemies), 1);

            const c2 = createClientWithView(state, view);
            put(kind, state.enemies, new Enemy().assign({ hp: 2 }), "b");
            encodeMultiple(encoder, state, [c1, c2]);
            assert.strictEqual(size(kind, c1.state.enemies), 2);
            assert.strictEqual(size(kind, c2.state.enemies), 2);
        });
    }
});

describe("stream backlog on idle ticks", () => {
    const Enemy = schema({ hp: t.number() }, "IdleEnemy");
    const State = schema({ enemies: t.stream(Enemy) }, "IdleState");

    it("Encoder#hasChanges stays true until a view's backlog drains", () => {
        const state = new State();
        state.enemies.maxPerTick = 1;
        const encoder = getEncoder(state);
        for (let i = 0; i < 3; i++) state.enemies.add(new Enemy().assign({ hp: i }));

        const busy = createClientWithView(state, new StateView());
        busy.view.subscribe(state.enemies);
        const idle = createClientWithView(state, new StateView());
        idle.view.add(state);

        // The server only patches while encoder.hasChanges — mirror that gate.
        let ticks = 0;
        const sizes: number[] = [];
        while (encoder.hasChanges) {
            const [busyPatch, idlePatch] = encodeMultiple(encoder, state, [busy, idle]);
            if (ticks > 0) sizes.push(idlePatch.length);
            ticks++;
            assert.ok(ticks < 10, "backlog never drained");
        }
        assert.strictEqual(ticks, 3);
        assert.strictEqual(busy.state.enemies.size, 3);
        // Clients without a backlog get empty patches on backlog-only ticks.
        assert.deepStrictEqual(sizes, [0, 0]);
    });

    it("a garbage-collected view's backlog does not keep hasChanges true", () => {
        const state = new State();
        state.enemies.maxPerTick = 1;
        const encoder = getEncoder(state);
        for (let i = 0; i < 3; i++) state.enemies.add(new Enemy().assign({ hp: i }));

        const view = new StateView();
        view.subscribe(state.enemies);
        assert.strictEqual(encoder.hasChanges, true);
        encoder.discardChanges();
        assert.strictEqual(encoder.hasChanges, true);

        // Simulate the WeakRef clearing without waiting on the GC.
        const root = encoder.root;
        root.activeViews.set(view.id, { deref: () => undefined } as any);
        assert.strictEqual(encoder.hasChanges, false);
    });

    it("Encoder#hasChanges stays true until the broadcast backlog drains", () => {
        const state = new State();
        state.enemies.maxPerTick = 1;
        const encoder = new Encoder(state);
        for (let i = 0; i < 3; i++) state.enemies.add(new Enemy().assign({ hp: i }));

        let ticks = 0;
        while (encoder.hasChanges) {
            encoder.encode();
            encoder.discardChanges();
            ticks++;
        }
        assert.strictEqual(ticks, 3);
    });
});
