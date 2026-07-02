// Full-state snapshot: encodeAll() over 5000 entities (bench_bloat M5).
import { buildBloatState } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/encode-all",
    unit: "ms/op",
    iterations: 15,
    reps: 7,
    setup(lib) {
        const { encoder } = buildBloatState(lib, 5000);
        encoder.encode();
        encoder.discardChanges();
        return { encoder };
    },
    run(ctx) {
        return ctx.encoder.encodeAll().byteLength;
    },
};
