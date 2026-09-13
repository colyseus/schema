import { schema, t } from "../../../src";

// a `let` can be reassigned before schema() runs — codegen must not guess
let MAX = 1;

export const Mutable = schema({
    value: t.quantized({ min: 0, max: MAX }),
});
