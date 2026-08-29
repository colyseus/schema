// Full-state snapshot: encodeAll() over 5000 entities (bench_bloat M5).
import { buildBloatState, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/encode-all",
    unit: "ms/op",
    iterations: 15,
    reps: 7,
    variants: withCodecs([{ name: "default" }]),
    setup(lib, variant) {
        const { encoder } = buildBloatState(lib, 5000, codecOf(lib, variant));
        encoder.encode();
        encoder.discardChanges();
        return { encoder };
    },
    run(ctx) {
        return ctx.encoder.encodeAll().byteLength;
    },
};
