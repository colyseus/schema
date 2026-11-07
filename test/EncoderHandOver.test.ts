import * as assert from "assert";

import { ArraySchema, Encoder, MapSchema, Reflection, Schema, SetSchema, StateView, schema, t, type, view } from "../src";
import { assertRefParity, createClientWithView, encodeMultiple } from "./Schema";

// `room.state = state` builds a new Encoder over instances a previous one encoded.
describe("Encoder hand-over", () => {

    class Leaf extends Schema {
        @type("number") value = 0;
    }

    class State extends Schema {
        @type({ map: Leaf }) m = new MapSchema<Leaf>();
        @type([Leaf]) a = new ArraySchema<Leaf>();
        @type({ set: Leaf }) s = new SetSchema<Leaf>();
        @type(Leaf) child: Leaf;
        @type(["number"]) prim = new ArraySchema<number>();
        @type("number") n = 0;
    }

    function connect(encoder: Encoder<State>) {
        const decoder = Reflection.decode<State>(Reflection.encode(encoder));
        const check = (label: string) => {
            assert.deepStrictEqual(decoder.state.toJSON(), encoder.state.toJSON(), label);
            assertRefParity(encoder.root, decoder.root, label);
        };
        decoder.decode(encoder.encodeAll());
        check("encodeAll");
        encoder.discardChanges();
        return (label: string) => {
            decoder.decode(encoder.encode());
            encoder.discardChanges();
            check(label);
        };
    }

    const fill: Record<string, (state: State) => void> = {
        map: (state) => state.m.set("l", new Leaf().assign({ value: 1 })),
        array: (state) => state.a.push(new Leaf().assign({ value: 1 })),
        set: (state) => state.s.add(new Leaf().assign({ value: 1 })),
        "child field": (state) => { state.child = new Leaf().assign({ value: 1 }); },
        "primitive array": (state) => state.prim.push(1, 2),
    };
    for (const [kind, populate] of Object.entries(fill)) {
        it(`encodeAll() carries a ${kind} the previous Encoder already sent`, () => {
            const state = new State();
            populate(state);
            const previous = new Encoder(state);
            previous.encode();
            previous.discardChanges();

            connect(new Encoder(state));
        });
    }

    for (const drained of [true, false]) {
        it(`new instances get fresh refIds (previous Encoder ${drained ? "drained" : "left with changes"})`, () => {
            const state = new State();
            state.m.set("a", new Leaf().assign({ value: 1 }));
            state.a.push(new Leaf().assign({ value: 2 }));
            const previous = new Encoder(state);
            previous.encode();
            if (drained) { previous.discardChanges(); }
            state.m.get("a")!.value = 11;
            state.m.set("b", new Leaf().assign({ value: 3 }));

            const tick = connect(new Encoder(state));

            state.m.set("c", new Leaf().assign({ value: 4 }));
            state.a.push(new Leaf().assign({ value: 5 }));
            state.child = new Leaf().assign({ value: 6 });
            tick("adds");

            state.m.get("a")!.value = 12;
            state.m.get("b")!.value = 13;
            tick("mutations");

            state.m.delete("a");
            state.a.shift();
            tick("removals");
        });
    }

    it("a StateView of the new Encoder does not inherit visibility from the previous one's", () => {
        class Item extends Schema {
            @type("number") v = 0;
        }
        class FilteredState extends Schema {
            @view() @type({ map: Item }) items = new MapSchema<Item>();
            @view() @type(Item) own: Item;
            @type("number") n = 0;
        }

        const state = new FilteredState();
        const secret = new Item().assign({ v: 42 });
        state.items.set("s", secret);
        state.own = new Item().assign({ v: 7 });

        const previous = new Encoder(state);
        const previousClient = createClientWithView(state, new StateView(), previous);
        previousClient.view.add(state.items);
        previousClient.view.add(secret);
        encodeMultiple(previous, state, [previousClient]);
        assert.strictEqual(previousClient.state.items.get("s")?.v, 42);

        const encoder = new Encoder(state);
        const client = createClientWithView(state, new StateView(), encoder);
        client.view.add(state.own);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.view.id, previousClient.view.id, "the new Root hands out the same view id");
        assert.strictEqual(client.state.own?.v, 7);
        assert.strictEqual(client.state.items?.get("s"), undefined);

        secret.v = 43;
        state.n = 1;
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.n, 1);
        assert.strictEqual(client.state.items?.get("s"), undefined);
    });

    describe("streams", () => {
        const Enemy = schema({ hp: t.number() }, "HandOverEnemy");
        const StreamState = schema({ enemies: t.stream(Enemy) }, "HandOverStreamState");

        it("a view of the new Encoder gets only what it subscribes to", () => {
            const state = new StreamState();
            state.enemies.maxPerTick = 1;
            for (let i = 0; i < 3; i++) { state.enemies.add(new Enemy().assign({ hp: i })); }

            const previous = new Encoder(state);
            const previousClient = createClientWithView(state, new StateView(), previous);
            previousClient.view.subscribe(state.enemies);
            encodeMultiple(previous, state, [previousClient]); // 1 sent, 2 left in its backlog

            const encoder = new Encoder(state);
            const client = createClientWithView(state, new StateView(), encoder);
            client.view.add(state);
            for (let i = 0; i < 4; i++) { encodeMultiple(encoder, state, [client]); }
            assert.strictEqual(client.view.id, previousClient.view.id, "the new Root hands out the same view id");
            assert.strictEqual(client.state.enemies?.size ?? 0, 0);

            client.view.subscribe(state.enemies);
            for (let i = 0; i < 4; i++) { encodeMultiple(encoder, state, [client]); }
            assert.strictEqual(client.state.enemies.size, 3);
        });

        it("broadcast: a client of the new Encoder ends up like a late joiner", () => {
            function sentOneOfThree() {
                const state = new StreamState();
                state.enemies.maxPerTick = 1;
                const encoder = new Encoder(state);
                for (let i = 0; i < 3; i++) { state.enemies.add(new Enemy().assign({ hp: i })); }
                encoder.encode();
                encoder.discardChanges();
                return { state, encoder };
            }
            function join(state: any, encoder: Encoder) {
                const decoder = Reflection.decode<any>(Reflection.encode(encoder));
                decoder.decode(encoder.encodeAll());
                encoder.discardChanges();
                state.enemies.add(new Enemy().assign({ hp: 9 }));
                for (let i = 0; i < 6; i++) {
                    decoder.decode(encoder.encode());
                    encoder.discardChanges();
                }
                return Array.from(decoder.state.enemies.values()).map((e: any) => e.hp).sort();
            }

            const single = sentOneOfThree();
            const lateJoiner = join(single.state, single.encoder);

            const handedOver = sentOneOfThree();
            assert.deepStrictEqual(join(handedOver.state, new Encoder(handedOver.state)), lateJoiner);
        });
    });

});
