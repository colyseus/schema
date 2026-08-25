//
// Codegen input for the cross-SDK input-layer fixtures — field order and
// types MUST match colyseus-0.18 PORTING/generate-input-fixtures.cts
// (MoveInput; the byte fixtures in each SDK's test suite decode against it).
//
import { schema, t } from "../src/index.js";

export const MoveInput = schema({
    vx: t.number(),
    vy: t.number(),
    jump: t.boolean(),
    action: t.uint8(),
}, "MoveInput");
