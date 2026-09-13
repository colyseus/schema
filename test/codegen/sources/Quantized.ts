import { schema, t } from "../../../src";
import { PITCH_LIMIT as LIMIT } from "./QuantizedLimits";
import { COARSE_BITS, PITCH_SPAN } from "./QuantizedBarrel";

const TAU = Math.PI * 2;

export const Look = schema({
    yaw: t.angle(),                                         // sugar → wrapping [0, 2π)
    pitch: t.quantized({ min: -LIMIT, max: LIMIT }),        // aliased import
    span: t.quantized({ min: 0, max: TAU, mode: "wrap" }),  // local const
    tilt: t.quantized({ min: 0, max: PITCH_SPAN / 2 }),     // through a barrel, chained
    coarse: t.angle({ bits: COARSE_BITS }),
    lastLocalTick: t.number().noSync(),
    after: t.uint8(),
});
