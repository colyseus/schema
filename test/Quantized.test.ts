import * as assert from "assert";
import { Schema, Encoder, Decoder, Reflection, schema, t, $values } from "../src";
import { InputEncoder, InputDecoder } from "../src/input";
import { quantize, dequantize, resolveQuantize } from "../src/types/quantize";

const TWO_PI = Math.PI * 2;
const PITCH_LIMIT = 1.5; // ~85.9°

/** Round-trip a single field assignment through encode + decode. */
function roundTrip<T extends Schema>(Ctor: new () => T, mutate: (s: T) => void): T {
    const src = new Ctor();
    const encoder = new Encoder(src);
    mutate(src);
    const it = { offset: 0 };
    const bytes = encoder.encode(it).slice(0, it.offset);

    const dst = new Ctor();
    new Decoder(dst).decode(bytes);
    return dst;
}

describe("t.quantized", () => {
    it("yaw (wrapping uint16) round-trips within one step of precision", () => {
        const Input = schema({ yaw: t.angle() });

        for (const rad of [0, 0.1, 1, Math.PI, TWO_PI - 0.001, -1, TWO_PI + 1, 100]) {
            const dst = roundTrip(Input, (s) => { s.yaw = rad; });
            // expected value reduced into [0, 2π)
            let expected = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
            const step = TWO_PI / 65536;
            const diff = Math.min(
                Math.abs(dst.yaw - expected),
                Math.abs(dst.yaw - expected + TWO_PI),
                Math.abs(dst.yaw - expected - TWO_PI),
            );
            assert.ok(diff <= step, `yaw=${rad}: decoded ${dst.yaw} vs ${expected} (diff ${diff} > ${step})`);
        }
    });

    it("pitch (clamped uint16) clamps out-of-range and round-trips", () => {
        const Input = schema({ pitch: t.quantized({ min: -PITCH_LIMIT, max: PITCH_LIMIT }) });
        const step = (2 * PITCH_LIMIT) / 65535;

        const dstHi = roundTrip(Input, (s) => { s.pitch = 99; });
        assert.ok(Math.abs(dstHi.pitch - PITCH_LIMIT) <= step, `clamp hi: ${dstHi.pitch}`);

        const dstLo = roundTrip(Input, (s) => { s.pitch = -99; });
        assert.ok(Math.abs(dstLo.pitch - (-PITCH_LIMIT)) <= step, `clamp lo: ${dstLo.pitch}`);

        const dstMid = roundTrip(Input, (s) => { s.pitch = 0.3 });
        assert.ok(Math.abs(dstMid.pitch - 0.3) <= step, `mid: ${dstMid.pitch}`);
    });

    it("mode selects clamp vs wrap (default clamp; rejects unknown)", () => {
        const clampDefault = resolveQuantize({ min: 0, max: 10 });            // omitted → clamp
        const clamp = resolveQuantize({ min: 0, max: 10, mode: "clamp" });
        const wrap = resolveQuantize({ min: 0, max: 10, mode: "wrap" });

        // Default is clamp, and `mode` maps to the internal descriptor boolean.
        assert.strictEqual(clampDefault.wrap, false);
        assert.strictEqual(clamp.wrap, false);
        assert.strictEqual(wrap.wrap, true);

        // CLAMP: out-of-range stops AT the nearest wall.
        assert.ok(Math.abs(dequantize(clamp, quantize(clamp, 12)) - 10) < 1e-9, "clamp hi → max");
        assert.ok(Math.abs(dequantize(clamp, quantize(clamp, -5)) - 0) < 1e-9, "clamp lo → min");

        // WRAP: max ≡ min, and out-of-range folds back into [min,max).
        const step = 10 / 65536;
        assert.strictEqual(quantize(wrap, 10), quantize(wrap, 0));           // max ≡ min
        assert.ok(Math.abs(dequantize(wrap, quantize(wrap, 12)) - 2) <= step, "wrap 12 → 2");
        assert.ok(Math.abs(dequantize(wrap, quantize(wrap, -1)) - 9) <= step, "wrap -1 → 9");

        // Unknown mode is rejected at define time.
        assert.throws(() => resolveQuantize({ min: 0, max: 10, mode: "bounce" as any }), /mode must be/);
    });

    it("rejects a non-finite range at define time", () => {
        assert.throws(() => resolveQuantize({ min: 0, max: Infinity }), /finite/);
        assert.throws(() => resolveQuantize({ min: -Infinity, max: 0 }), /finite/);
        assert.throws(() => resolveQuantize({ min: 0, max: NaN }), /finite/);
    });

    it("non-finite values quantize deterministically (no local NaN vs wire divergence)", () => {
        // The field's promise is that the stored value IS dequant(q) — the same
        // value the peer decodes. NaN must not leak into $values while the wire
        // carries an unrelated integer.
        const clamp = resolveQuantize({ min: -1.5, max: 1.5 });
        const wrap = resolveQuantize({ min: 0, max: TWO_PI, mode: "wrap" });

        assert.strictEqual(quantize(clamp, NaN), 0);              // NaN → min
        assert.strictEqual(quantize(wrap, NaN), 0);
        assert.strictEqual(quantize(wrap, Infinity), 0);          // irreducible → min
        assert.strictEqual(quantize(wrap, -Infinity), 0);
        assert.strictEqual(quantize(clamp, Infinity), clamp.span);  // clamps to max
        assert.strictEqual(quantize(clamp, -Infinity), 0);          // clamps to min

        // Through the setter: the instance stores dequant(q), never NaN.
        const Input = schema({ pitch: t.quantized({ min: -1.5, max: 1.5 }), yaw: t.angle() });
        const s = new Input();
        s.pitch = NaN;
        s.yaw = Infinity;
        assert.strictEqual(s.pitch, -1.5);
        assert.strictEqual(s.yaw, 0);

        // And the peer decodes the same values the instance holds.
        const dst = roundTrip(Input, (d) => { d.pitch = NaN; d.yaw = Infinity; });
        assert.strictEqual(dst.pitch, s.pitch);
        assert.strictEqual(dst.yaw, s.yaw);
    });

    it("the field yields the wire-exact value immediately on the producer (no full-precision leak)", () => {
        const Input = schema({ yaw: t.angle(), pitch: t.quantized({ min: -PITCH_LIMIT, max: PITCH_LIMIT }) });
        const desc = resolveQuantize({ min: 0, max: TWO_PI, mode: "wrap" });

        const src = new Input();
        src.yaw = 1.23456789;
        // Reading back yields dequant(quant(x)) — NOT the raw float.
        assert.strictEqual(src.yaw, dequantize(desc, quantize(desc, 1.23456789)));
        assert.notStrictEqual(src.yaw, 1.23456789);

        // And it matches what a decoder reconstructs from the wire.
        const dst = roundTrip(Input, (s) => { s.yaw = 1.23456789; });
        assert.strictEqual(dst.yaw, src.yaw);
    });

    it("setter snapping is idempotent (decode → setter does not re-quantize)", () => {
        const desc = resolveQuantize({ min: -PITCH_LIMIT, max: PITCH_LIMIT });
        for (let q = 0; q <= 65535; q += 257) {
            const x = dequantize(desc, q);
            assert.strictEqual(quantize(desc, x), q, `q=${q} not stable through dequant→quant`);
        }
        // wrapping endpoints
        const w = resolveQuantize({ min: 0, max: TWO_PI, mode: "wrap" });
        for (let q = 0; q < 65536; q += 251) {
            assert.strictEqual(quantize(w, dequantize(w, q)), q, `wrap q=${q} unstable`);
        }
    });

    it("supports 8 / 16 / 32 bit widths on the wire", () => {
        const widths: Array<{ bits: 8 | 16 | 32; bytes: number }> = [
            { bits: 8, bytes: 1 }, { bits: 16, bytes: 2 }, { bits: 32, bytes: 4 },
        ];
        for (const { bits, bytes } of widths) {
            const Input = schema({ v: t.quantized({ min: 0, max: 1, bits }) });
            const src = new Input();
            const encoder = new Encoder(src);
            src.v = 0.5;
            const it = { offset: 0 };
            const buf = encoder.encode(it).slice(0, it.offset);
            // wire body = [index|op byte] + N value bytes
            assert.strictEqual(buf.length, 1 + bytes, `bits=${bits} body length`);

            const dst = new Input();
            new Decoder(dst).decode(buf);
            const step = 1 / (Math.pow(2, bits) - 1);
            assert.ok(Math.abs(dst.v - 0.5) <= step, `bits=${bits}: ${dst.v}`);
        }
    });

    it("bits:32 WRAPPING round-trips (exercises `% steps`, not `& mask`)", () => {
        // At bits:32 the step span is 2^32, which overflows int32 — so the wrap codec
        // must fold the top step with `% steps`, not a bitwise mask. Round-trip a
        // wrapping field across the seam + out-of-range inputs and assert no overflow.
        const Input = schema({ a: t.quantized({ min: 0, max: TWO_PI, mode: "wrap", bits: 32 }) });
        const desc = resolveQuantize({ min: 0, max: TWO_PI, mode: "wrap", bits: 32 });
        const steps = Math.pow(2, 32);
        const step = TWO_PI / steps;

        for (const rad of [0, 1e-7, 1, Math.PI, TWO_PI - 1e-7, -1, TWO_PI + 0.5, 1000]) {
            const dst = roundTrip(Input, (s) => { s.a = rad; });
            const expected = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
            const diff = Math.min(
                Math.abs(dst.a - expected),
                Math.abs(dst.a - expected + TWO_PI),
                Math.abs(dst.a - expected - TWO_PI),
            );
            assert.ok(diff <= step, `a=${rad}: decoded ${dst.a} vs ${expected} (diff ${diff} > ${step})`);
        }

        // The top step folds onto 0 (max ≡ min) and no quantized value escapes uint32.
        assert.strictEqual(quantize(desc, 0), 0);
        assert.strictEqual(quantize(desc, TWO_PI), 0);
        assert.ok(quantize(desc, TWO_PI - step / 4) < steps, "near-seam q stays within uint32");
        assert.strictEqual(dequantize(desc, quantize(desc, Math.PI)), dequantize(desc, steps / 2));
    });

    it("quantized field is half the bytes of float32", () => {
        const Quant = schema({ yaw: t.angle() });
        const Float = schema({ yaw: t.float32() });

        const measure = (Ctor: any) => {
            const s = new Ctor();
            const enc = new Encoder(s);
            s.yaw = 1.2345;
            const it = { offset: 0 };
            return enc.encode(it).slice(0, it.offset).length;
        };
        assert.strictEqual(measure(Quant), 1 + 2); // index + uint16
        assert.strictEqual(measure(Float), 1 + 4); // index + float32
    });

    it("does not emit a delta when a sub-step change quantizes to the same integer", () => {
        const Input = schema({ yaw: t.angle() });
        const src = new Input();
        const enc = new InputEncoder(src);

        src.yaw = 1.0;
        assert.ok(enc.encode().length > 0, "first write emits");
        // After snapping, the stored value sits at the step CENTER (±0.5 step from
        // either rounding boundary), so perturbing by < 0.5 step stays the same q.
        const center = src.yaw;
        const stepRad = TWO_PI / 65536;

        src.yaw = center + stepRad * 0.3; // within ±0.5 step of center → same q
        assert.strictEqual(enc.encode().length, 0, "sub-step jitter should not emit a delta");

        src.yaw = center + stepRad * 0.8; // crosses the +0.5 boundary → new q
        assert.ok(enc.encode().length > 0, "a real step change emits");
    });

    it("InputEncoder → InputDecoder carries quantized fields", () => {
        const Input = schema({ yaw: t.angle(), pitch: t.quantized({ min: -PITCH_LIMIT, max: PITCH_LIMIT }), moveF: t.int8() });
        const src = new Input();
        const enc = new InputEncoder(src);
        const dstInstance = new Input();
        const dec = new InputDecoder(dstInstance);

        src.yaw = 2.0; src.pitch = -0.4; src.moveF = 1;
        dec.decode(enc.encode());

        assert.strictEqual(dstInstance.yaw, src.yaw);
        assert.strictEqual(dstInstance.pitch, src.pitch);
        assert.strictEqual(dstInstance.moveF, 1);
    });

    it("survives a Reflection round-trip (handshake cascade) and still encodes", () => {
        // The input schema reaches the client via the server handshake (reflection),
        // so the quantized descriptor must serialize + reconstruct exactly.
        const Input = schema({ yaw: t.angle(), pitch: t.quantized({ min: -PITCH_LIMIT, max: PITCH_LIMIT }), moveF: t.int8() });
        const src = new Input();
        const encoder = new Encoder(src);

        // Rebuild the class purely from reflection bytes (what the client does).
        const reflected = Reflection.decode(Reflection.encode(encoder)).state.constructor as new () => any;
        Reflection.makeEncodable(reflected);

        // The reflected class must ENCODE quantized fields (this threw before the
        // Reflection support: "non-primitive field 'yaw' ... is not supported").
        const r = new reflected();
        r.yaw = 2.0; r.pitch = -0.4; r.moveF = 1;
        const enc = new InputEncoder(r);
        const bytes = enc.encode();

        // Decode through the ORIGINAL class and confirm the values match.
        const dst = new Input();
        new InputDecoder(dst).decode(bytes);
        assert.strictEqual(dst.yaw, dequantize(resolveQuantize({ min: 0, max: Math.PI * 2, mode: "wrap" }), quantize(resolveQuantize({ min: 0, max: Math.PI * 2, mode: "wrap" }), 2.0)));
        assert.ok(Math.abs(dst.pitch - (-0.4)) <= (2 * PITCH_LIMIT) / 65535);
        assert.strictEqual(dst.moveF, 1);
    });

    it("stores the snapped float in $values (not the integer)", () => {
        const Input = schema({ yaw: t.angle() });
        const s = new Input();
        s.yaw = 1.0;
        // $values holds the dequantized float, so reads are a plain slot read.
        assert.ok(Math.abs((s as any)[$values][0] - 1.0) < (TWO_PI / 65536));
        assert.strictEqual((s as any)[$values][0], s.yaw);
    });
});
