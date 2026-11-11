import * as assert from "assert";
import { Schema, type, MapSchema, Encoder, Decoder, decode } from "../src";

class Entry extends Schema {
    @type("string") name: string;
}

class State extends Schema {
    @type({ map: Entry }) entries = new MapSchema<Entry>();
    @type({ map: "string" }) labels = new MapSchema<string>();
}

function entry(name: string) {
    const e = new Entry();
    e.name = name;
    return e;
}

function pair() {
    const state = new State();
    const encoder = new Encoder(state);
    const decoded = new State();
    const decoder = new Decoder(decoded);
    const sync = () => { decoder.decode(encoder.encode()); encoder.discardChanges(); };
    return { state, encoder, decoded, decoder, sync };
}

/** The decoded map's key → index table, as the encoder's map has it. */
function assertSameIndexes(decoded: MapSchema<any>, source: MapSchema<any>) {
    assert.deepStrictEqual(
        [...decoded.indexByKey].sort(),
        [...source.keys()].map((key) => [key, source.indexByKey.get(key)]).sort(),
    );
}

describe("Decoder fast paths", () => {
    describe("short strings", () => {
        it("round-trips every length around the short / long boundary", () => {
            const { state, decoded, sync } = pair();
            for (let length = 0; length <= 20; length++) {
                state.labels.set("ascii" + length, "abcdefghijklmnopqrstuvwxyz".slice(0, length));
                state.labels.set("accent" + length, "é".repeat(length));
                state.labels.set("mixed" + length, [..."a日😀b" + "x".repeat(20)].slice(0, length).join("")); // by code point: no lone surrogate
            }
            sync();
            assert.deepStrictEqual(decoded.labels.toJSON(), state.labels.toJSON());
        });

        it("reads every path from a typed array and from a plain array", () => {
            const samples = [13, 15, 16, 47, 48, 200, 4095, 4096, 10000].flatMap((length) => [
                "abcdefghij".repeat(1000).slice(0, length),
                [..."añ日😀".repeat(2500)].slice(0, length).join(""),
            ]);
            for (const sample of samples) {
                const bytes = new TextEncoder().encode(sample);
                // a plain array has no `subarray`: long strings go through the unit loop in pieces
                for (const buffer of [bytes, Array.from(bytes)]) {
                    const it = { offset: 0 };
                    assert.strictEqual(decode.utf8Read(buffer as any, it, bytes.length), sample);
                    assert.strictEqual(it.offset, bytes.length);
                }
            }
        });

        it("decodes short non-ASCII map keys", () => {
            const { state, decoded, sync } = pair();
            for (const key of ["é", "ключ", "日本", "😀", "a\u007fb", "\u0080"]) state.labels.set(key, key);
            sync();
            assert.deepStrictEqual([...decoded.labels.keys()], [...state.labels.keys()]);
        });
    });

    describe("lazy key → index table of a decoded map", () => {
        it("stays unbuilt through a full sync and matches the encoder's once read", () => {
            const { state, encoder, decoded, decoder } = pair();
            for (let i = 0; i < 50; i++) state.entries.set("k" + i, entry("n" + i));
            decoder.decode(encoder.encodeAll());
            encoder.discardChanges();
            assert.strictEqual((decoded.entries as any).$indexByKey, undefined);
            assertSameIndexes(decoded.entries, state.entries);
        });

        it("follows adds, deletes, replacements and index reuse", () => {
            const { state, decoded, sync } = pair();
            for (let i = 0; i < 20; i++) state.entries.set("k" + i, entry("n" + i));
            sync();
            for (let t = 0; t < 60; t++) {
                state.entries.delete("k" + (t % 20));
                if (t % 3 === 0) state.entries.set("k" + ((t + 7) % 20), entry("r" + t)); // replace or re-add
                state.entries.set("new" + t, entry("x" + t)); // takes a freed index
                if (t % 4 === 0) state.entries.delete("new" + (t - 2));
                sync();
                assert.deepStrictEqual(decoded.entries.toJSON(), state.entries.toJSON(), `tick ${t}`);
                if (t % 5 === 0) assertSameIndexes(decoded.entries, state.entries); // builds it mid-stream on the first read
            }
            assertSameIndexes(decoded.entries, state.entries);
        });

        it("built late, it equals the encoder's after random churn", () => {
            for (let seed = 1; seed <= 40; seed++) {
                let x = seed * 2654435761 >>> 0;
                const rnd = (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
                const { state, decoded, sync } = pair();
                const ticks = 1 + rnd(30);
                for (let t = 0; t < ticks; t++) {
                    for (let op = rnd(6); op >= 0; op--) {
                        const key = "k" + rnd(12);
                        if (rnd(3) === 0) state.entries.delete(key);
                        else state.entries.set(key, entry("s" + seed + "t" + t));
                    }
                    if (rnd(25) === 0) state.entries.clear();
                    sync();
                }
                assert.deepStrictEqual(decoded.entries.toJSON(), state.entries.toJSON(), `seed ${seed}`);
                assertSameIndexes(decoded.entries, state.entries);
            }
        });

        it("a delete and re-add of one key in a tick keeps the newer index", () => {
            const { state, decoded, sync } = pair();
            state.entries.set("a", entry("1"));
            state.entries.set("b", entry("2"));
            sync();
            state.entries.delete("a");
            state.entries.set("c", entry("3"));
            state.entries.set("a", entry("4"));
            sync();
            assert.deepStrictEqual(decoded.entries.toJSON(), state.entries.toJSON());
            assertSameIndexes(decoded.entries, state.entries);
        });

        it("clear() then refill", () => {
            const { state, decoded, sync } = pair();
            for (let i = 0; i < 5; i++) state.entries.set("k" + i, entry("n" + i));
            sync();
            state.entries.clear();
            state.entries.set("k3", entry("again"));
            sync();
            assert.deepStrictEqual(decoded.entries.toJSON(), state.entries.toJSON());
            assertSameIndexes(decoded.entries, state.entries);
        });

        it("a decoded map mutated locally and re-encoded", () => {
            const { state, encoder, decoded, decoder } = pair();
            for (let i = 0; i < 5; i++) state.entries.set("k" + i, entry("n" + i));
            decoder.decode(encoder.encodeAll());

            const relay = new Encoder(decoded);
            const third = new State();
            const thirdDecoder = new Decoder(third);
            thirdDecoder.decode(relay.encodeAll());
            relay.discardChanges();
            decoded.entries.set("k2", entry("replaced"));
            decoded.entries.delete("k0");
            decoded.entries.set("fresh", entry("f"));
            thirdDecoder.decode(relay.encode());
            assert.deepStrictEqual(third.entries.toJSON(), decoded.entries.toJSON());
        });
    });
});
