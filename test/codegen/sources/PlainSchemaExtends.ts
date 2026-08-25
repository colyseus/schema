import { schema, t } from "../../../src";
import { Vec3 } from "./PlainSchema";

export const Vec4 = Vec3.extend({
    z: t.number(),
}, "Vec4");

export const State = schema({
    vec: t.ref(Vec3),
    vecs: t.map(Vec3),
}, "State");
