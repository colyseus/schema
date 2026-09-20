import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, Encoder, Decoder, schema, t, deprecated } from "../src";
import { uvarint } from "../src/encoding/varint";
import {
    createInstanceFromReflection, assertDeepStrictEqualEncodeAll, assertRefIdCounts, getEncoder, getDecoder,
    createClientWithView, encodeMultiple,
} from "./Schema";

/** Chunk-framing cases that used to live in the v5/v6 differential harness. */
describe("Codec (chunks, bodies, robustness)", () => {

    class Player extends Schema {
        @type("string") name: string;
        @type("number") x: number = 0;
    }
    class State extends Schema {
        @type({ map: Player }) players = new MapSchema<Player>();
        @type([Player]) list = new ArraySchema<Player>();
        @type(["number"]) numbers = new ArraySchema<number>();
    }

    function withWarnings(fn: () => void): string[] {
        const warnings: string[] = [];
        const warn = console.warn, error = console.error;
        console.warn = (...args: any[]) => warnings.push(String(args[0]));
        console.error = (...args: any[]) => warnings.push(String(args[0]));
        try { fn(); } finally { console.warn = warn; console.error = error; }
        return warnings;
    }

    it("mid-tick join + array slot write replaces instead of inserting", () => {
        const state = new State();
        state.numbers.push(7, 1);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        state.numbers[1] = 2;
        client.decode(state.encode());
        assert.deepStrictEqual(client.numbers.toJSON(), [7, 2]);
    });

    it("skips a chunk for an unknown refId and keeps decoding", () => {
        const state = new State();
        state.players.set("a", new Player().assign({ name: "a" }));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());

        state.players.get("a").x = 5;
        const patch = state.encode();

        // splice a bogus chunk (refId 250, 2 bytes) in front of the real one
        const bogus = new Uint8Array(8);
        const it = { offset: 0 };
        uvarint(bogus, 250 * 2 + 1, it); uvarint(bogus, 2 * 2, it); bogus[it.offset++] = 0; bogus[it.offset++] = 0; // absolute header, len*2
        const spliced = Encoder.concat([bogus.subarray(0, it.offset), patch]);

        const warnings = withWarnings(() => client.decode(spliced));
        assert.ok(warnings.some((w) => w.includes("refId")));
        assert.strictEqual(client.players.get("a").x, 5);
    });

    it("recovers from a truncated chunk length and an unknown field index", () => {
        const state = new State();
        state.players.set("a", new Player().assign({ name: "a" }));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());

        // truncated: declares more bytes than available
        const truncated = new Uint8Array([1, 80, 2]); // header 1 = refId 0 (absolute), len 40 (*2)
        let warnings = withWarnings(() => client.decode(truncated));
        assert.ok(warnings.some((w) => w.includes("truncated")));

        // unknown field index 9 on the root
        const bad = new Uint8Array(3);
        bad[0] = 1; bad[1] = 2; bad[2] = (9 << 2) | 2; // header 1 = refId 0, len 1 (*2)
        warnings = withWarnings(() => client.decode(bad));
        assert.ok(warnings.some((w) => w.includes("field not defined") || w.includes("definition mismatch")));
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });

    it("refIds past 16 383 and chunks past 127 bytes", () => {
        const state = new State();
        const encoder = getEncoder(state);
        // burn refIds
        for (let i = 0; i < 17000; i++) state.players.set(`p${i}`, new Player().assign({ name: `p${i}` }));
        encoder.encode(); encoder.discardChanges();
        for (let i = 0; i < 17000; i++) state.players.delete(`p${i}`);
        encoder.encode(); encoder.discardChanges();

        state.players.set("late", new Player().assign({ name: "late" }));
        for (let i = 0; i < 300; i++) state.numbers.push(i);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        assert.deepStrictEqual(client.toJSON(), state.toJSON());

        state.players.get("late").x = 1;
        for (let i = 0; i < 300; i++) state.numbers[i] = i + 1;
        client.decode(state.encode());
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assertRefIdCounts(state, client);
    });

    it("grows the shared buffer on overflow and re-encodes", () => {
        const previous = Encoder.BUFFER_SIZE;
        Encoder.BUFFER_SIZE = 32;
        try {
            const state = new State();
            const encoder = new Encoder(state);
            for (let i = 0; i < 50; i++) state.players.set(`p${i}`, new Player().assign({ name: `player-${i}` }));
            const client = createInstanceFromReflection(state, encoder);
            const warnings = withWarnings(() => {
                client.decode(encoder.encodeAll());
                client.decode(encoder.encode());
            });
            assert.ok(warnings.some((w) => w.includes("buffer overflow")));
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        } finally {
            Encoder.BUFFER_SIZE = previous;
        }
    });

    it("wide schema: 40 fields with a @view tag on field 35", () => {
        const def: any = {};
        for (let i = 0; i < 40; i++) def[`f${i}`] = t.number();
        const Wide = schema(def, "WideCodec");
        class WideState extends Schema {
            @type(Wide) wide = new Wide();
        }
        // tag field 35 after the fact
        view()(Wide.prototype, "f35");

        const state = new WideState();
        const encoder = getEncoder(state); // the helpers memoize one encoder per state
        for (let i = 0; i < 40; i++) (state.wide as any)[`f${i}`] = i;

        const client = createClientWithView(state);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual((client.state.wide as any).f34, 34);
        assert.strictEqual((client.state.wide as any).f35, undefined);

        client.view.add(state.wide);
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual((client.state.wide as any).f35, 35);
        (state.wide as any).f35 = 350;
        (state.wide as any).f36 = 360;
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual((client.state.wide as any).f35, 350);
        assert.strictEqual((client.state.wide as any).f36, 360);
    });

    it("a @deprecated field is consumed but not applied", () => {
        class Old extends Schema {
            @type("string") keep: string;
            @type("string") gone: string;
            @type("number") after: number;
        }
        const state = new Old();
        state.keep = "k"; state.gone = "g"; state.after = 7;

        const client = createInstanceFromReflection(state);
        deprecated()(client.constructor.prototype, "gone");
        client.decode(state.encodeAll());
        assert.strictEqual(client.keep, "k");
        assert.strictEqual(client.after, 7);
    });

    it("random-op self-consistency: client mirrors the server over 60 ticks with a mid-way joiner", () => {
        let seed = 42;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const state = new State();
        const encoder = getEncoder(state);
        const client = createInstanceFromReflection(state);
        client.decode(encoder.encodeAll());
        let late: State | undefined;
        let n = 0;

        for (let tick = 0; tick < 60; tick++) {
            const ops = 1 + Math.floor(rand() * 6);
            for (let k = 0; k < ops; k++) {
                const r = rand();
                if (r < 0.2) state.numbers.push(Math.floor(rand() * 100));
                else if (r < 0.3 && state.numbers.length) state.numbers.splice(Math.floor(rand() * state.numbers.length), 1);
                else if (r < 0.4 && state.numbers.length) state.numbers[Math.floor(rand() * state.numbers.length)] = Math.floor(rand() * 100);
                else if (r < 0.5) state.list.push(new Player().assign({ name: `n${n++}` }));
                else if (r < 0.6 && state.list.length) state.list.splice(Math.floor(rand() * state.list.length), 1);
                else if (r < 0.65 && state.list.length) state.list.reverse();
                else if (r < 0.7 && state.list.length) state.list[Math.floor(rand() * state.list.length)].x = Math.floor(rand() * 100);
                else if (r < 0.8) state.players.set(`p${Math.floor(rand() * 10)}`, new Player().assign({ name: "p" }));
                else if (r < 0.9) state.players.delete(`p${Math.floor(rand() * 10)}`);
                else if (r < 0.95 && state.numbers.length) state.numbers.unshift(-1);
                else if (state.list.length) state.list.sort((a, b) => a.x - b.x);

                if (tick === 30 && k === 2) {
                    late = createInstanceFromReflection(state);
                    late.decode(encoder.encodeAll());
                }
            }
            const patch = encoder.encode();
            client.decode(patch);
            late?.decode(patch);
            encoder.discardChanges();
            assert.deepStrictEqual(client.toJSON(), state.toJSON(), `tick ${tick}`);
            if (late) assert.deepStrictEqual(late.toJSON(), state.toJSON(), `late tick ${tick}`);
        }
        assertRefIdCounts(state, client);
        assertRefIdCounts(state, late!);
        assertDeepStrictEqualEncodeAll(state);
    });
});
