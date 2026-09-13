import { schema, t } from "../../../src";

// t.angle() on its own — no consts — so its desugaring is tested in isolation.
export const Aim = schema({
    yaw: t.angle(),
    coarse: t.angle({ bits: 8 }),
    after: t.uint8(),
});
