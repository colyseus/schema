import { schema, t } from "../../../src";

export const Vec3 = schema({
    x: t.number(),
    y: t.number(),
    z: t.number(),
}, "Vec3");
