import * as assert from "assert";
import { existsSync } from "fs";

// Two physical copies of the bundle in one process (Node keys ESM instances by
// full URL). Classes are always defined with copy A. Runs on `npm test`, which
// builds the bundle first; skipped when the bundle is missing.
const BUNDLE = new URL("../build/index.mjs", import.meta.url);
const describeBundle = existsSync(BUNDLE) ? describe : describe.skip;

describeBundle("Cross-copy runtime interop (two bundle copies)", function () {
    let A: any, B: any;
    let Item: any, Sub: any, Secret: any, State: any;

    before(async () => {
        A = await import(BUNDLE.href);
        B = await import(BUNDLE.href + "?copy=b");

        const { Schema, MapSchema, ArraySchema, SetSchema, type, view } = A;
        class _Item extends Schema {}
        type("number")(_Item.prototype, "x");
        type("number")(_Item.prototype, "y");
        type("string")(_Item.prototype, "name");
        class _Sub extends _Item {}
        type("number")(_Sub.prototype, "z");
        class _Secret extends Schema {}
        type("string")(_Secret.prototype, "code");
        class _State extends Schema {
            constructor() {
                super();
                this.items = new MapSchema();
                this.list = new ArraySchema();
                this.tags = new SetSchema();
                this.nested = new _Item();
                this.tick = 0;
                this.secret = new _Secret();
            }
        }
        type({ map: _Item })(_State.prototype, "items");
        type([_Item])(_State.prototype, "list");
        type({ set: "string" })(_State.prototype, "tags");
        type(_Item)(_State.prototype, "nested");
        type("number")(_State.prototype, "tick");
        type(_Secret)(_State.prototype, "secret");
        view()(_State.prototype, "secret");
        Item = _Item; Sub = _Sub; Secret = _Secret; State = _State;
    });

    function makeItem(i: number, sub = false) {
        const item = sub ? new Sub() : new Item();
        item.x = i; item.y = i * 2; item.name = "i" + i;
        if (sub) { item.z = -i; }
        return item;
    }

    // deterministic mutations covering every collection kind + polymorphism
    function mutate(state: any, t: number) {
        state.tick = t;
        const k = "k" + (t % 13);
        if (t % 5 === 0) { state.items.delete(k); }
        else if (t % 7 === 0 && state.items.has(k)) { state.items.get(k).x = t; }
        else { state.items.set(k, makeItem(t, t % 3 === 0)); }

        if (t % 4 === 0 && state.list.length > 0) { state.list.splice(t % state.list.length, 1); }
        else if (t % 9 === 0 && state.list.length > 0) { state.list[0] = makeItem(t); }
        else if (t % 11 === 0) { state.list.reverse(); }
        else if (state.list.length < 20) { state.list.push(makeItem(t, t % 2 === 0)); }

        if (t % 6 === 0) { state.tags.add("t" + (t % 17)); }
        if (t % 10 === 0) { state.tags.delete("t" + ((t - 60) % 17)); }

        if (t % 50 === 0) { state.nested = makeItem(t, true); }
        else { state.nested.y = t; }
        state.secret.code = "c" + t;
    }

    const copy = (u8: Uint8Array) => u8.slice();
    const json = (s: any) => { const j = s.toJSON(); delete j.secret; return j; };

    it("loads two distinct copies", () => {
        assert.notStrictEqual(A.MapSchema, B.MapSchema);
        assert.notStrictEqual(A.Schema, B.Schema);
    });

    it.skip("encoders of both copies produce identical bytes and type tables", () => {
        const sA = new State(), sB = new State();
        const encA = new A.Encoder(sA), encB = new B.Encoder(sB);
        assert.deepStrictEqual(
            [...encB.context.schemas.entries()].map(([k, id]: any) => [k.name, id]),
            [...encA.context.schemas.entries()].map(([k, id]: any) => [k.name, id]),
        );
        for (let t = 1; t <= 300; t++) {
            mutate(sA, t); mutate(sB, t);
            assert.deepStrictEqual(copy(encB.encode()), copy(encA.encode()), `tick ${t}`);
            encA.discardChanges(); encB.discardChanges();
        }
        assert.deepStrictEqual(copy(encB.encodeAll()), copy(encA.encodeAll()));
    });

    it.skip("a foreign Encoder leaves this copy's metadata alone", () => {
        new B.Encoder(new State());
        class Later extends A.Schema {}
        A.type("string")(Later.prototype, "only");
        assert.deepStrictEqual(Later[Symbol.metadata][0].name, "only");
        assert.strictEqual(Later[Symbol.metadata][1], undefined);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(A.Schema, Symbol.metadata), false);
    });

    function roundTrip(Enc: any, Dec: any, ticks: number) {
        const warn = console.warn; const warnings: any[] = [];
        console.warn = (...args: any[]) => warnings.push(args);
        try {
            const state = new State();
            const encoder = new Enc.Encoder(state);
            const decoded = new State();
            const decoder = new Dec.Decoder(decoded);
            decoder.decode(copy(encoder.encodeAll()));
            for (let t = 1; t <= ticks; t++) {
                mutate(state, t);
                decoder.decode(copy(encoder.encode()));
                encoder.discardChanges();
                if (t % 100 === 0) { assert.deepStrictEqual(json(decoded), json(state), `tick ${t}`); }
            }
            assert.deepStrictEqual(warnings, []);
            return { state, decoded, decoder, encoder };
        } finally {
            console.warn = warn;
        }
    }

    it.skip("Encoder B over instances of A round-trips (2000 ticks)", () => {
        roundTrip(B, A, 2000);
    });

    it.skip("Decoder B over classes of A builds A's collections", () => {
        const { decoded, decoder } = roundTrip(A, B, 500);
        assert.ok(decoded.items instanceof A.MapSchema);
        assert.ok(decoded.list instanceof A.ArraySchema);
        assert.ok(decoded.tags instanceof A.SetSchema);
        for (const get of [A.Callbacks.get, B.Callbacks.get]) {
            const $ = get(decoder);
            assert.strictEqual(typeof $.onAdd, "function");
        }
    });

    it.skip("callbacks fire through either copy's Callbacks.get", () => {
        const state = new State();
        const encoder = new A.Encoder(state);
        const decoder = new B.Decoder(new State());
        const added: string[] = [];
        A.Callbacks.get(decoder).onAdd("items", (_: any, key: string) => added.push("A" + key));
        B.Callbacks.get(decoder).onAdd("items", (_: any, key: string) => added.push("B" + key));
        state.items.set("one", makeItem(1));
        decoder.decode(copy(encoder.encodeAll()));
        assert.deepStrictEqual(added.sort(), ["Aone", "Bone"]);
    });

    it.skip("a foreign collection assigned by the user keeps its tree", () => {
        const state = new State();
        const encoder = new A.Encoder(state);
        const decoded = new State();
        const decoder = new A.Decoder(decoded);
        decoder.decode(copy(encoder.encodeAll()));

        const foreign = new B.MapSchema();
        state.items = foreign;
        assert.strictEqual(state.items, foreign);
        foreign.set("a", makeItem(1));
        state.list = new B.ArraySchema(makeItem(2));
        state.list.push(makeItem(3));
        decoder.decode(copy(encoder.encode()));
        encoder.discardChanges();
        assert.deepStrictEqual(json(decoded), json(state));

        assert.strictEqual(new A.MapSchema(foreign).size, 1);
    });

    it.skip("Reflection round-trips in both directions, then streams patches", () => {
        for (const [Enc, Dec] of [[A, B], [B, A]]) {
            const state = new State();
            mutate(state, 1);
            const encoder = new Enc.Encoder(state);
            const decoder = Dec.Reflection.decode(Enc.Reflection.encode(encoder));
            decoder.decode(copy(encoder.encodeAll()));
            for (let t = 2; t <= 200; t++) {
                mutate(state, t);
                decoder.decode(copy(encoder.encode()));
                encoder.discardChanges();
            }
            assert.deepStrictEqual(json(decoder.state), json(state));
        }
    });

    it.skip("StateView across copies", () => {
        const state = new State();
        const encoder = new B.Encoder(state);
        const view = new B.StateView();
        view.add(state.secret);
        const decoded = new State();
        const decoder = new A.Decoder(decoded);
        for (let t = 1; t <= 50; t++) {
            mutate(state, t);
            const it = { offset: 0 };
            if (t === 1) {
                encoder.encodeAll(it);
                decoder.decode(copy(B.Encoder.concat(encoder.encodeAllView(view, it.offset, it))));
            } else {
                encoder.encode(it);
                decoder.decode(copy(B.Encoder.concat(encoder.encodeView(view, it.offset, it))));
            }
            encoder.discardChanges();
        }
        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
    });

    it.skip("re-encodes a state decoded by the other copy", () => {
        const { decoded } = roundTrip(A, B, 100);
        const encoder = new A.Encoder(decoded);
        const again = new State();
        new B.Decoder(again).decode(copy(encoder.encodeAll()));
        assert.deepStrictEqual(json(again), json(decoded));
    });
});
