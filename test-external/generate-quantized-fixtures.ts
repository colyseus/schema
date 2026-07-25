//
// Generates byte fixtures for the Phase-1 SDK ports (5.0 reflection format +
// t.quantized decode — see colyseus-0.18 PORTING/sdk-ports-quantized-reflection.md
// and PORTING/sdk-coverage-plan-0.18.md).
//
// Every fixture is SELF-VERIFYING: reflection bytes are decoded with the real
// 5.0 `Reflection.decode`, state/patch bytes with the resulting Decoder, and
// every quantized value asserted bit-exact against the reference codec — a
// fixture that doesn't reproduce aborts generation.
//
// Run: npx tsx --tsconfig tsconfig.test.json test-external/generate-quantized-fixtures.ts
//
import * as assert from "assert";
import { Schema, Encoder, Decoder, Reflection, schema, t } from "../src";
import { quantize, dequantize, resolveQuantize, QuantizeDescriptor } from "../src/types/quantize";

const TWO_PI = Math.PI * 2;

//
// Fixture schema — exercises every 5.0 reflection shape:
//   quantized (wrap/clamp × 8/16/32 bits), collections of primitives
//   (childPrimitive slot — the 4.x colon packing is gone), schema refs,
//   collections of schemas, and plain primitives.
//
const QChild = schema({
    v: t.number(),
}, "QChild");

const QState = schema({
    yaw: t.quantized({ min: 0, max: TWO_PI, bits: 16, mode: "wrap" }),
    pitch: t.quantized({ min: -1.5, max: 1.5, bits: 8 }), // clamp (default)
    precise: t.quantized({ min: 0, max: 1, bits: 32 }),
    nums: t.array("number"),
    tags: t.map("string"),
    child: t.ref(QChild),
    items: t.array(QChild),
    label: t.string(),
}, "QState");

const DESCRIPTORS: Record<string, QuantizeDescriptor> = {
    yaw: resolveQuantize({ min: 0, max: TWO_PI, bits: 16, mode: "wrap" }),
    pitch: resolveQuantize({ min: -1.5, max: 1.5, bits: 8 }),
    precise: resolveQuantize({ min: 0, max: 1, bits: 32 }),
};

/** Wire-exact expected value: what the decoder must yield for an input. */
const expected = (field: keyof typeof DESCRIPTORS, input: number) =>
    dequantize(DESCRIPTORS[field], quantize(DESCRIPTORS[field], input));

// ─── 1. reflection handshake + state + patch ─────────────────────────────────
{
    const state = new QState();
    const encoder = new Encoder(state);

    state.yaw = 1.25;
    state.pitch = 0.7;
    state.precise = 0.123456789;
    state.nums.push(1, 2.5, 3);
    state.tags.set("a", "x");
    state.child = new QChild().assign({ v: 7 });
    state.items.push(new QChild().assign({ v: 1 }), new QChild().assign({ v: 2 }));
    state.label = "q";

    const reflectionBytes = Uint8Array.from(Reflection.encode(encoder));
    // copy immediately — encodeAll() returns a view into a shared buffer
    const stateBytes = Uint8Array.from(encoder.encodeAll());
    encoder.encode(); // drain initial changes
    encoder.discardChanges();

    state.yaw = 4.0;
    state.pitch = -99; // clamps to min
    state.nums.push(4);
    const patchBytes = Uint8Array.from(encoder.encode());
    encoder.discardChanges();

    // self-verify through the real Reflection.decode + Decoder
    const decoder = Reflection.decode(Uint8Array.from(reflectionBytes));
    decoder.decode(Uint8Array.from(stateBytes));
    const decoded: any = decoder.state;

    assert.strictEqual(decoded.yaw, expected("yaw", 1.25));
    assert.strictEqual(decoded.pitch, expected("pitch", 0.7));
    assert.strictEqual(decoded.precise, expected("precise", 0.123456789));
    assert.deepStrictEqual(decoded.nums.toJSON(), [1, 2.5, 3]);
    assert.strictEqual(decoded.tags.get("a"), "x");
    assert.strictEqual(decoded.child.v, 7);
    assert.deepStrictEqual(decoded.items.map((i: any) => i.v), [1, 2]);
    assert.strictEqual(decoded.label, "q");

    decoder.decode(patchBytes);
    assert.strictEqual(decoded.yaw, expected("yaw", 4.0));
    assert.strictEqual(decoded.pitch, expected("pitch", -99));
    assert.deepStrictEqual(decoded.nums.toJSON(), [1, 2.5, 3, 4]);

    console.log("=== quantized_reflection ===");
    console.log(`reflection (${reflectionBytes.length} bytes):`);
    console.log(`  ${Array.from(reflectionBytes).join(", ")}`);
    console.log(`state (${stateBytes.length} bytes):`);
    console.log(`  ${Array.from(stateBytes).join(", ")}`);
    console.log(`patch (${patchBytes.length} bytes):`);
    console.log(`  ${Array.from(patchBytes).join(", ")}`);
    console.log(`// yaw: quantized wrap bits=16 min=0 max=${String(TWO_PI)}`);
    console.log(`// pitch: quantized clamp bits=8 min=-1.5 max=1.5`);
    console.log(`// precise: quantized clamp bits=32 min=0 max=1`);
    console.log(`// after state: yaw=${String(expected("yaw", 1.25))} pitch=${String(expected("pitch", 0.7))} precise=${String(expected("precise", 0.123456789))}`);
    console.log(`//   nums=[1, 2.5, 3] tags={a: 'x'} child.v=7 items.v=[1, 2] label='q'`);
    console.log(`// after patch: yaw=${String(expected("yaw", 4.0))} pitch=${String(expected("pitch", -99))} nums=[1, 2.5, 3, 4]`);
}

// ─── 2. codec vectors (behavior lock for the per-language ports) ─────────────
{
    const vectors: Array<[string, QuantizeDescriptor]> = [
        ["clamp8_0_10", resolveQuantize({ min: 0, max: 10, bits: 8 })],
        ["clamp16_pitch", resolveQuantize({ min: -1.5, max: 1.5, bits: 16 })],
        ["clamp32_unit", resolveQuantize({ min: 0, max: 1, bits: 32 })],
        ["wrap16_angle", resolveQuantize({ min: 0, max: TWO_PI, bits: 16, mode: "wrap" })],
        ["wrap8_degrees", resolveQuantize({ min: 0, max: 360, bits: 8, mode: "wrap" })],
        ["wrap32_angle", resolveQuantize({ min: 0, max: TWO_PI, bits: 32, mode: "wrap" })],
    ];

    // includes: bounds, mid values, an exact .5 rounding case (10 * 0.5/255 →
    // q lands on x.5), out-of-range both sides, huge accumulated angles
    // (float-domain wrap), negative inputs, and non-finite garbage
    const inputs = [
        0, 1, 10, 0.0196078431372549, 5.5, -1.5, 1.5, 0.3, -99, 99,
        Math.PI, TWO_PI, TWO_PI + 1, -1, 360, 720.5, 1e6, -1e6, 0.123456789,
        NaN, Infinity, -Infinity,
    ];

    console.log("\n=== quantized_codec_vectors ===");
    console.log("// desc: name min max bits mode span");
    for (const [name, d] of vectors) {
        console.log(`// ${name}: min=${String(d.min)} max=${String(d.max)} bits=${d.bits} mode=${d.wrap ? "wrap" : "clamp"} span=${d.span}`);
    }
    console.log("// rows: desc, input, q, roundtrip (shortest-roundtrip float64 strings)");
    for (const [name, d] of vectors) {
        for (const input of inputs) {
            const q = quantize(d, input);
            const rt = dequantize(d, q);
            // self-check: q is always a valid wire integer
            assert.ok(Number.isInteger(q) && q >= 0 && q < Math.pow(2, d.bits) + (d.wrap ? 0 : 1),
                `${name} input=${input} produced invalid q=${q}`);
            console.log(`${name}, ${String(input)}, ${q}, ${String(rt)}`);
        }
    }
}

console.error("\nAll fixtures self-verified against the 5.0 reference (Reflection.decode + quantize/dequantize).");
