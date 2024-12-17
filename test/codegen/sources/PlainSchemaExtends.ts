import { schema } from "../../../src";
import { Vec3 } from "./PlainSchema";

export const Vec4 = Vec3.extends({
    z: "number"
});

export const State = schema({
    vec: Vec3,
    vecs: { map: Vec3 }
});