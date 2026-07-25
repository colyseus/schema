//
// Codegen input for the cross-SDK t.quantized fixtures — field order and
// quantize params MUST match test-external/generate-quantized-fixtures.ts
// (the byte fixtures embedded in each SDK's test suite decode against these).
//
import { schema, t } from "../src/index.js";

export const QChild = schema({
    v: t.number(),
}, "QChild");

export const QState = schema({
    yaw: t.quantized({ min: 0, max: Math.PI * 2, bits: 16, mode: "wrap" }),
    pitch: t.quantized({ min: -1.5, max: 1.5, bits: 8 }),
    precise: t.quantized({ min: 0, max: 1, bits: 32 }),
    nums: t.array("number"),
    tags: t.map("string"),
    child: t.ref(QChild),
    items: t.array(QChild),
    label: t.string(),
}, "QState");
