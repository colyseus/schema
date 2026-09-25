import { Schema, schema, t, type } from "../../../src";

// The option forms codegen reads without resolving anything: literals and
// constant Math arithmetic.
export const Literal = schema({
    axis: t.quantized({ min: -1, max: 1 }),                                    // 16-bit clamp by default
    heading: t.quantized({ min: 0, max: Math.PI * 2, bits: 8, mode: "wrap" }),
    speed: t.quantized({ min: 0, max: 10 * 2, bits: 32, mode: "clamp" }),
});

export class LiteralDecorated extends Schema {
    @type({ quantized: { min: -(1 / 2), max: 1 / 2, bits: 8 } }) lean: number;
}
