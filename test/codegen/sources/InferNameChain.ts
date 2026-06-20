import { schema, t } from "@colyseus/schema";

// chained schema(...).extend(...) — base of the outer .extend is a call, not
// an identifier, so codegen can't name it; must NOT hang.
export const Vec5 = schema({
    a: t.number(),
}).extend({
    b: t.number(),
});
