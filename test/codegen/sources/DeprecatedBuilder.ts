import { schema, t } from "../../../src";

// Same shape as DeprecatedDecorator.ts — generated output must be identical.
export const Versioned = schema({
    kept: t.string(),
    old: t.string().deprecated(),
    soft: t.number().deprecated(false),
    last: t.string(),
}, "Versioned");

// A trailing `.deprecated()` must not bleed into the next structure's first field.
export const After = schema({
    first: t.string(),
}, "After");
