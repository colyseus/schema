import { schema, t } from "../../../src";

// `t.array(t.string())` is rejected at runtime; codegen must match, not emit
// `ArraySchema<undefined>`.
export const BuilderChild = schema({
    items: t.array(t.string()),
}, "BuilderChild");
