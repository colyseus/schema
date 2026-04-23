import * as assert from "assert";
import { Schema, type, Encoder, Decoder } from "../src";
import { InputEncoder, InputDecoder } from "../src/input";

describe("InputEncoder / InputDecoder", () => {

    it("should emit wire-compatible bytes matching the full Encoder", () => {
        class Input extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("number") vy: number;
            @type("boolean") key_l: boolean;
            @type("boolean") key_r: boolean;
            @type("boolean") key_u: boolean;
            @type("boolean") key_d: boolean;
        }

        // Full-encoder reference bytes.
        const refState = new Input();
        const encoder = new Encoder(refState);
        refState.seq = 42;
        refState.vx = 0.5;
        refState.vy = -0.25;
        refState.key_l = true;
        refState.key_r = false;
        refState.key_u = true;
        refState.key_d = false;

        const it1 = { offset: 0 };
        const bufFull = encoder.encode(it1).slice(0, it1.offset);

        // InputEncoder path.
        const oneState = new Input();
        oneState.seq = 42;
        oneState.vx = 0.5;
        oneState.vy = -0.25;
        oneState.key_l = true;
        oneState.key_r = false;
        oneState.key_u = true;
        oneState.key_d = false;

        const input = new InputEncoder(oneState);
        const bufOne = input.encode();

        assert.deepStrictEqual(Array.from(bufOne), Array.from(bufFull));
    });

    it("should emit bytes matching encoder.encodeAll() (full-sync snapshot)", () => {
        class Input extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("number") vy: number;
            @type("boolean") key_l: boolean;
            @type("boolean") key_r: boolean;
            @type("boolean") key_u: boolean;
            @type("boolean") key_d: boolean;
        }

        const refState = new Input();
        const encoder = new Encoder(refState);
        refState.seq = 42;
        refState.vx = 0.5;
        refState.vy = -0.25;
        refState.key_l = true;
        refState.key_r = false;
        refState.key_u = true;
        refState.key_d = false;

        // Drain pending tick changes first so encodeAll's output isn't
        // conflated with the initial ADDs.
        encoder.encode();
        encoder.discardChanges();

        const itAll = { offset: 0 };
        const bufAll = encoder.encodeAll(itAll).slice(0, itAll.offset);

        const oneState = new Input();
        oneState.seq = 42;
        oneState.vx = 0.5;
        oneState.vy = -0.25;
        oneState.key_l = true;
        oneState.key_r = false;
        oneState.key_u = true;
        oneState.key_d = false;

        const input = new InputEncoder(oneState);
        const bufOne = input.encode();

        assert.deepStrictEqual(Array.from(bufOne), Array.from(bufAll));
    });

    it("should round-trip through InputDecoder", () => {
        class Input extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("number") vy: number;
            @type("boolean") key_l: boolean;
            @type("boolean") key_r: boolean;
            @type("boolean") key_u: boolean;
            @type("boolean") key_d: boolean;
        }

        const src = new Input();
        src.seq = 1337;
        src.vx = 1.5;
        src.vy = -2.25;
        src.key_l = true;
        src.key_r = false;
        src.key_u = true;
        src.key_d = true;

        const enc = new InputEncoder(src);
        const bytes = enc.encode();

        const dst = new Input();
        const dec = new InputDecoder(dst);
        const decoded = dec.decode(bytes);

        assert.strictEqual(decoded, dst); // returns the bound instance
        assert.strictEqual(dst.seq, 1337);
        assert.strictEqual(dst.vx, 1.5);
        assert.strictEqual(dst.vy, -2.25);
        assert.strictEqual(dst.key_l, true);
        assert.strictEqual(dst.key_r, false);
        assert.strictEqual(dst.key_u, true);
        assert.strictEqual(dst.key_d, true);
    });

    it("should round-trip through the standard Decoder (wire-compat)", () => {
        class Input extends Schema {
            @type("number") seq: number;
            @type("boolean") pressed: boolean;
        }

        const src = new Input();
        src.seq = 99;
        src.pressed = true;

        const bytes = new InputEncoder(src).encode();

        const dst = new Input();
        new Decoder(dst).decode(bytes);

        assert.strictEqual(dst.seq, 99);
        assert.strictEqual(dst.pressed, true);
    });

    it("should expose `mode` (defaults to 'reliable')", () => {
        class Input extends Schema {
            @type("number") x: number;
        }

        const a = new InputEncoder(new Input());
        assert.strictEqual(a.mode, "reliable");

        const b = new InputEncoder(new Input(), { mode: "unreliable" });
        assert.strictEqual(b.mode, "unreliable");

        const c = new InputEncoder(new Input(), { mode: "reliable" });
        assert.strictEqual(c.mode, "reliable");
    });

    describe("unreliable mode (ring-buffer)", () => {

        class RingInput extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("boolean") pressed: boolean;
        }

        it("first encode packs a single length-framed input equal to reliable bytes", () => {
            const reliableSrc = new RingInput();
            reliableSrc.seq = 5;
            reliableSrc.vx = 1.25;
            reliableSrc.pressed = true;

            const unreliableSrc = new RingInput();
            unreliableSrc.seq = 5;
            unreliableSrc.vx = 1.25;
            unreliableSrc.pressed = true;

            const reliable = new InputEncoder(reliableSrc);
            const unreliable = new InputEncoder(unreliableSrc, { mode: "unreliable", historySize: 3 });

            const bR = reliable.encode();
            const bU = unreliable.encode();

            // Unreliable output = [len][reliable bytes]. First byte = length.
            assert.strictEqual(bU[0], bR.length);
            assert.deepStrictEqual(Array.from(bU.slice(1)), Array.from(bR));
        });

        it("accumulates inputs into the packet up to historySize", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 3 });
            const dst = new RingInput();
            const dec = new InputDecoder(dst);

            const decodedSeqs: number[][] = [];
            for (let i = 1; i <= 3; i++) {
                src.seq = i;
                src.vx = i * 0.5;
                src.pressed = (i & 1) === 1;
                const bytes = enc.encode();

                const seqs: number[] = [];
                dec.decodeAll(bytes, (inst) => seqs.push(inst.seq));
                decodedSeqs.push(seqs);
            }

            assert.deepStrictEqual(decodedSeqs, [
                [1],
                [1, 2],
                [1, 2, 3],
            ]);
        });

        it("drops oldest once historySize is exceeded (ring wrap)", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 3 });
            const dst = new RingInput();
            const dec = new InputDecoder(dst);

            let lastBytes: Uint8Array = new Uint8Array();
            for (let i = 1; i <= 5; i++) {
                src.seq = i;
                src.vx = i * 0.5;
                src.pressed = (i & 1) === 1;
                lastBytes = enc.encode();
            }

            const seqs: number[] = [];
            dec.decodeAll(lastBytes, (inst) => seqs.push(inst.seq));
            assert.deepStrictEqual(seqs, [3, 4, 5]);
        });

        it("decodeAll preserves order (oldest → newest) and passes input index", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 4 });
            const dst = new RingInput();
            const dec = new InputDecoder(dst);

            for (let i = 10; i < 14; i++) {
                src.seq = i; src.vx = i; src.pressed = false;
                enc.encode();
            }
            src.seq = 14; src.vx = 14; src.pressed = true;
            const bytes = enc.encode();

            const observed: Array<[number, number]> = [];
            const count = dec.decodeAll(bytes, (inst, idx) => {
                observed.push([idx, inst.seq]);
            });

            assert.strictEqual(count, 4);
            assert.deepStrictEqual(observed, [[0, 11], [1, 12], [2, 13], [3, 14]]);
        });

        it("reset() drops the ring so the next packet contains only the new input", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 3 });
            const dst = new RingInput();
            const dec = new InputDecoder(dst);

            for (let i = 1; i <= 3; i++) {
                src.seq = i; src.vx = i; src.pressed = false;
                enc.encode();
            }

            enc.reset();

            src.seq = 99; src.vx = 99; src.pressed = true;
            const bytes = enc.encode();

            const seqs: number[] = [];
            dec.decodeAll(bytes, (inst) => seqs.push(inst.seq));
            assert.deepStrictEqual(seqs, [99]);
        });

        it("ring-buffer snapshots are independent (mutating src between encodes doesn't rewrite past slots)", () => {
            // Regression guard: if _encodeInto wrote into a shared scratch
            // buffer that overlapped with a past ring slot, the older slot
            // would contain the newer bytes after a later encode.
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 3 });
            const dst = new RingInput();
            const dec = new InputDecoder(dst);

            src.seq = 1; src.vx = 1.5; src.pressed = false;
            enc.encode();

            src.seq = 2; src.vx = 2.5; src.pressed = true;
            const bytes = enc.encode();

            const observed: Array<[number, number, boolean]> = [];
            dec.decodeAll(bytes, (inst) => observed.push([inst.seq, inst.vx, inst.pressed]));

            assert.deepStrictEqual(observed, [
                [1, 1.5, false],
                [2, 2.5, true],
            ]);
        });

        it("historySize defaults to 3", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src, { mode: "unreliable" });
            assert.strictEqual(enc.historySize, 3);
        });

        it("reliable mode has historySize = 1", () => {
            const src = new RingInput();
            const enc = new InputEncoder(src);
            assert.strictEqual(enc.historySize, 1);
        });

    });

    it("should pause tracking on the bound instance when delta is off", () => {
        class Input extends Schema {
            @type("number") x: number;
        }

        // Full-snapshot mode: setter change-tracking is pure overhead,
        // encoder pauses it.
        const a = new Input();
        assert.strictEqual(a.isTrackingPaused, false);
        new InputEncoder(a);
        assert.strictEqual(a.isTrackingPaused, true);

        // Delta mode: encoder *reads* the setter-populated dirty bits,
        // so tracking must stay active.
        const b = new Input();
        new InputEncoder(b, { delta: true });
        assert.strictEqual(b.isTrackingPaused, false);
    });

    it("should skip undefined fields", () => {
        class Partial extends Schema {
            @type("number") a: number;
            @type("number") b: number;
            @type("number") c: number;
        }

        const src = new Partial();
        src.a = 10;
        // b left undefined
        src.c = 30;

        const bytes = new InputEncoder(src).encode();

        const dst = new Partial();
        new InputDecoder(dst).decode(bytes);

        assert.strictEqual(dst.a, 10);
        assert.strictEqual(dst.b, undefined);
        assert.strictEqual(dst.c, 30);
    });

    it("should support strings", () => {
        class Msg extends Schema {
            @type("string") name: string;
            @type("number") count: number;
        }

        const src = new Msg();
        src.name = "hello";
        src.count = 7;

        const bytes = new InputEncoder(src).encode();

        const dst = new Msg();
        new InputDecoder(dst).decode(bytes);

        assert.strictEqual(dst.name, "hello");
        assert.strictEqual(dst.count, 7);
    });

    it("should reuse its internal buffer across encode() calls", () => {
        class Input extends Schema {
            @type("number") seq: number;
        }

        const src = new Input();
        const enc = new InputEncoder(src);

        src.seq = 1;
        const b1 = enc.encode();
        const first = Array.from(b1);

        src.seq = 2;
        const b2 = enc.encode();

        // Same underlying ArrayBuffer — enc owns one buffer for its lifetime.
        assert.strictEqual(b1.buffer, b2.buffer);

        // Bytes are fresh per call: decoding the second output yields seq=2,
        // not seq=1, even though the view was mutated in place.
        const dst = new Input();
        new InputDecoder(dst).decode(b2);
        assert.strictEqual(dst.seq, 2);

        // And the first subarray now reflects the mutation (same memory).
        assert.notDeepStrictEqual(Array.from(b1), first);
    });

    it("should accept a user-supplied buffer", () => {
        class Input extends Schema {
            @type("number") seq: number;
        }

        const buf = new Uint8Array(128);
        const src = new Input();
        const enc = new InputEncoder(src, { buffer: buf });

        src.seq = 42;
        const out = enc.encode();

        assert.strictEqual(out.buffer, buf.buffer);
    });

    it("should throw on non-primitive fields (nested Schema)", () => {
        class Position extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class Thing extends Schema {
            @type("number") id: number;
            @type(Position) position = new Position();
        }

        assert.throws(() => new InputEncoder(new Thing()), /non-primitive/i);
    });

    it("should throw on classes without fields", () => {
        class Empty extends Schema {}
        assert.throws(() => new InputEncoder(new Empty()), /no fields/i);
    });

    describe("buffer overflow", () => {

        // Silence the one-time console.warn that fires on growth.
        let originalWarn: typeof console.warn;
        before(() => { originalWarn = console.warn; console.warn = () => {}; });
        after(() => { console.warn = originalWarn; });

        it("reliable mode auto-grows the buffer when a string exceeds initial size", () => {
            class Msg extends Schema {
                @type("string") text: string;
                @type("number") seq: number;
            }

            const src = new Msg();
            // 8KB text — well beyond the 256-byte default.
            const longText = "x".repeat(8 * 1024);
            src.text = longText;
            src.seq = 42;

            const enc = new InputEncoder(src);
            const bytes = enc.encode();

            // Round-trip must preserve the full string (no silent truncation).
            const dst = new Msg();
            new InputDecoder(dst).decode(bytes);
            assert.strictEqual(dst.text.length, longText.length);
            assert.strictEqual(dst.text, longText);
            assert.strictEqual(dst.seq, 42);
        });

        it("unreliable mode auto-grows a ring slot when a single input overflows", () => {
            class Msg extends Schema {
                @type("string") text: string;
                @type("number") seq: number;
            }

            const src = new Msg();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 2 });

            src.text = "x".repeat(4 * 1024);
            src.seq = 1;
            enc.encode();

            src.text = "y".repeat(4 * 1024);
            src.seq = 2;
            const bytes = enc.encode();

            const dst = new Msg();
            const dec = new InputDecoder(dst);
            const seqs: Array<[number, number]> = [];
            dec.decodeAll(bytes, (inst) => seqs.push([inst.seq, inst.text.length]));

            assert.deepStrictEqual(seqs, [
                [1, 4 * 1024],
                [2, 4 * 1024],
            ]);
        });

        it("unreliable mode auto-grows the output buffer when the packet exceeds its size", () => {
            // 6-slot ring × ~2KB per input easily exceeds the default output buffer.
            class Msg extends Schema {
                @type("string") text: string;
                @type("uint32") seq: number;
            }

            const src = new Msg();
            const enc = new InputEncoder(src, { mode: "unreliable", historySize: 6 });

            for (let i = 0; i < 6; i++) {
                src.text = String.fromCharCode(65 + i).repeat(2 * 1024);
                src.seq = i;
                enc.encode();
            }

            src.text = "Z".repeat(2 * 1024);
            src.seq = 99;
            const bytes = enc.encode();

            const dst = new Msg();
            const dec = new InputDecoder(dst);
            const seqs: number[] = [];
            dec.decodeAll(bytes, (inst) => {
                seqs.push(inst.seq);
                assert.strictEqual(inst.text.length, 2 * 1024);
            });

            assert.deepStrictEqual(seqs, [1, 2, 3, 4, 5, 99]);
        });

        it("subsequent encodes reuse the grown buffer (no repeated allocation)", () => {
            class Msg extends Schema {
                @type("string") text: string;
            }

            const src = new Msg();
            const enc = new InputEncoder(src);

            // Grow once
            src.text = "x".repeat(4 * 1024);
            const a = enc.encode();
            const aBuffer = a.buffer;

            // Encode something smaller — should still use the already-grown buffer.
            src.text = "hi";
            const b = enc.encode();
            assert.strictEqual(b.buffer, aBuffer, "buffer should be retained, not re-shrunk");

            // And another large encode is a no-grow fast path now.
            src.text = "y".repeat(3 * 1024);
            const c = enc.encode();
            assert.strictEqual(c.buffer, aBuffer);
        });

    });

    describe("delta encoding (reliable)", () => {

        // One test (`overflow-retry doesn't corrupt the baseline`) pushes
        // an 8KB string through the wrapped Encoder, which emits a
        // buffer-overflow warning as it grows. Silence it here so the
        // suite output stays clean; the behavior is still asserted.
        let originalWarn: typeof console.warn;
        before(() => { originalWarn = console.warn; console.warn = () => {}; });
        after(() => { console.warn = originalWarn; });

        class DeltaInput extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("number") vy: number;
            @type("boolean") fire: boolean;
        }

        it("first call emits a full snapshot", () => {
            const src = new DeltaInput();
            src.seq = 1;
            src.vx = 0.5;
            src.vy = -0.25;
            src.fire = true;

            // Reference bytes from a full-snapshot encoder on a twin.
            const twin = new DeltaInput();
            twin.seq = 1; twin.vx = 0.5; twin.vy = -0.25; twin.fire = true;
            const refBytes = new InputEncoder(twin).encode();

            const enc = new InputEncoder(src, { delta: true });
            const deltaBytes = enc.encode();

            assert.deepStrictEqual(Array.from(deltaBytes), Array.from(refBytes));
        });

        it("second call emits only changed fields", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0.5; src.vy = -0.25; src.fire = false;

            const enc = new InputEncoder(src, { delta: true });
            const first = enc.encode();
            assert.ok(first.length > 0);

            src.seq = 2;
            const second = enc.encode();

            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);
            dec.decode(first);
            dec.decode(second);

            assert.strictEqual(dst.seq, 2);
            assert.strictEqual(dst.vx, 0.5);
            assert.strictEqual(dst.vy, -0.25);
            assert.strictEqual(dst.fire, false);

            assert.ok(second.length < first.length, `expected delta < full (${second.length} vs ${first.length})`);
        });

        it("returns an empty Uint8Array when nothing changed", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0.5; src.vy = 0.5; src.fire = true;

            const enc = new InputEncoder(src, { delta: true });
            enc.encode(); // baseline

            const noop = enc.encode();
            assert.strictEqual(noop.length, 0);
            assert.ok(noop instanceof Uint8Array);
        });

        it("re-emits a field if it flips back and forth", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0; src.vy = 0; src.fire = false;

            const enc = new InputEncoder(src, { delta: true });
            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);

            dec.decode(enc.encode()); // baseline

            src.fire = true;
            dec.decode(enc.encode());
            assert.strictEqual(dst.fire, true);

            src.fire = false;
            dec.decode(enc.encode());
            assert.strictEqual(dst.fire, false);

            src.fire = true;
            dec.decode(enc.encode());
            assert.strictEqual(dst.fire, true);
        });

        it("handles multiple independent changes across calls", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0; src.vy = 0; src.fire = false;

            const enc = new InputEncoder(src, { delta: true });
            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);

            // Baseline.
            dec.decode(enc.encode());

            // Tick 1: vx + seq change
            src.seq = 2; src.vx = 1.25;
            dec.decode(enc.encode());
            assert.strictEqual(dst.seq, 2);
            assert.strictEqual(dst.vx, 1.25);
            assert.strictEqual(dst.vy, 0);
            assert.strictEqual(dst.fire, false);

            // Tick 2: only vy changes
            src.vy = -0.5;
            dec.decode(enc.encode());
            assert.strictEqual(dst.vy, -0.5);

            // Tick 3: nothing changes
            assert.strictEqual(enc.encode().length, 0);
        });

        it("reset() clears the delta baseline — next encode() is full", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0.5; src.vy = 0.5; src.fire = true;

            const enc = new InputEncoder(src, { delta: true });
            const first = enc.encode(); // full snapshot

            assert.strictEqual(enc.encode().length, 0); // nothing changed

            enc.reset();
            const afterReset = enc.encode();
            assert.deepStrictEqual(Array.from(afterReset), Array.from(first));
        });

        it("overflow-retry doesn't corrupt the baseline", () => {
            // Regression guard: if overflow retry re-walked the delta loop
            // after `last[]` was updated mid-emit, the retry would see "no
            // changes" and produce corrupt (truncated) output.
            class BigMsg extends Schema {
                @type("string") text: string;
                @type("number") seq: number;
            }

            const src = new BigMsg();
            const enc = new InputEncoder(src, { delta: true });

            // Small baseline — buffer fits.
            src.text = "x"; src.seq = 1;
            enc.encode();

            // Now both fields change and text is huge — triggers overflow.
            src.text = "y".repeat(8 * 1024);
            src.seq = 2;
            const bytes = enc.encode();

            const dst = new BigMsg();
            const dec = new InputDecoder(dst);
            dec.decode(bytes);
            assert.strictEqual(dst.text.length, 8 * 1024);
            assert.strictEqual(dst.seq, 2);

            assert.strictEqual(enc.encode().length, 0);
        });

        it("exposes `delta` on the encoder (defaults to false)", () => {
            const a = new InputEncoder(new DeltaInput());
            assert.strictEqual(a.delta, false);

            const b = new InputEncoder(new DeltaInput(), { delta: true });
            assert.strictEqual(b.delta, true);
        });

    });

    describe("delta encoding (unreliable + ring-buffer)", () => {

        class DeltaInput extends Schema {
            @type("number") seq: number;
            @type("number") vx: number;
            @type("boolean") fire: boolean;
        }

        it("first call emits one slot containing a full snapshot", () => {
            const src = new DeltaInput();
            src.seq = 1; src.vx = 0.5; src.fire = true;

            const enc = new InputEncoder(src, { mode: "unreliable", delta: true, historySize: 3 });
            const bytes = enc.encode();
            assert.ok(bytes.length > 0);

            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);
            const seqs: number[] = [];
            dec.decodeAll(bytes, (inst) => seqs.push(inst.seq));

            assert.deepStrictEqual(seqs, [1]);
            assert.strictEqual(dst.vx, 0.5);
            assert.strictEqual(dst.fire, true);
        });

        it("no-change tick doesn't push a new slot but still emits the ring", () => {
            const src = new DeltaInput();
            const enc = new InputEncoder(src, { mode: "unreliable", delta: true, historySize: 3 });

            src.seq = 1; src.vx = 0.5; src.fire = true;
            const first = enc.encode();

            // No mutation between encodes → no new slot pushed, but ring emitted again.
            const second = enc.encode();
            assert.deepStrictEqual(Array.from(second), Array.from(first));
        });

        it("accumulates per-tick deltas into the ring", () => {
            const src = new DeltaInput();
            const enc = new InputEncoder(src, { mode: "unreliable", delta: true, historySize: 3 });
            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);

            src.seq = 1; src.vx = 0.5; src.fire = false;
            enc.encode();                        // slot 0: full snapshot delta

            src.seq = 2;                         // only seq changed
            enc.encode();                        // slot 1: seq delta

            src.fire = true;                     // only fire changed
            const bytes = enc.encode();          // slot 2: fire delta

            const observed: Array<[number, number, boolean]> = [];
            dec.decodeAll(bytes, (inst) => observed.push([inst.seq, inst.vx, inst.fire]));

            // Deltas are applied in order, each mutating only its changed fields.
            assert.deepStrictEqual(observed, [
                [1, 0.5, false],
                [2, 0.5, false],
                [2, 0.5, true],
            ]);
        });

        it("drops oldest delta when historySize is exceeded", () => {
            const src = new DeltaInput();
            const enc = new InputEncoder(src, { mode: "unreliable", delta: true, historySize: 2 });
            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);

            src.seq = 1; src.vx = 0.5; src.fire = false; enc.encode();
            src.seq = 2; enc.encode();
            src.seq = 3; enc.encode();
            src.seq = 4; const bytes = enc.encode();

            const seqs: number[] = [];
            dec.decodeAll(bytes, (inst) => seqs.push(inst.seq));
            assert.deepStrictEqual(seqs, [3, 4]);
        });

        it("returns empty Uint8Array if no changes have ever been pushed", () => {
            // Fresh encoder, no field set → no baseline, nothing to emit.
            const src = new DeltaInput();
            const enc = new InputEncoder(src, { mode: "unreliable", delta: true });
            const bytes = enc.encode();
            assert.strictEqual(bytes.length, 0);
        });

        it("reset() drops both the ring and the delta baseline", () => {
            const src = new DeltaInput();
            const enc = new InputEncoder(src, { mode: "unreliable", delta: true, historySize: 3 });

            src.seq = 1; src.vx = 0.5; src.fire = true; enc.encode();
            src.seq = 2; enc.encode();

            enc.reset();

            // After reset: ring is empty and baseline is cleared. Next
            // encode() sees the instance's current values as "all changed"
            // vs the fresh empty baseline and emits a full snapshot as a
            // single slot.
            const afterReset = enc.encode();
            const dst = new DeltaInput();
            const dec = new InputDecoder(dst);
            const seqs: number[] = [];
            dec.decodeAll(afterReset, (inst) => seqs.push(inst.seq));
            assert.deepStrictEqual(seqs, [2]);
            assert.strictEqual(dst.vx, 0.5);
            assert.strictEqual(dst.fire, true);

            // With the baseline now caught up, a no-change tick re-emits
            // only that one slot (no new slot pushed).
            const noMutation = enc.encode();
            assert.deepStrictEqual(Array.from(noMutation), Array.from(afterReset));
        });

    });

    it("should allow re-encoding after mutation", () => {
        class Input extends Schema {
            @type("number") seq: number;
        }

        const src = new Input();
        const enc = new InputEncoder(src);

        for (let i = 0; i < 5; i++) {
            src.seq = i * 10;
            const bytes = enc.encode();

            const dst = new Input();
            new InputDecoder(dst).decode(bytes);
            assert.strictEqual(dst.seq, i * 10, `iteration ${i}`);
        }
    });

});
