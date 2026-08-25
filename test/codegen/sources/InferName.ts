import { schema, t } from "../../../src";

// No explicit name arg → the codegen parser infers "Vec3" from the variable.
export const Vec3 = schema({
    x: t.number(),
    y: t.number(),
});

// `.extend()` with no name arg → inferred "Vec4", extending the inferred "Vec3".
export const Vec4 = Vec3.extend({
    z: t.number(),
});
