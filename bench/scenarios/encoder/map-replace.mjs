// REPLACE-heavy tick over a Map<number> of 1000 entries: the first 10 % /
// 100 % of the keys get a new value each tick (the hottest primitive-map op —
// the 6.x fold `uvarint(index * 8 + op)` makes each of them one byte shorter).
import { buildMapState } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/map-replace",
    unit: "ms/tick",
    iterations: 3000,
    reps: 7,
    variants: [
        { name: "str-10pct", key: "string", count: 100 },
        { name: "str-100pct", key: "string", count: 1000 },
        { name: "num-10pct", key: "number", count: 100 },
        { name: "num-100pct", key: "number", count: 1000 },
    ],
    setup(lib, variant) {
        const { state, encoder, key } = buildMapState(lib, variant.key, 0, 1000);
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder, key, count: variant.count };
    },
    run(ctx, i) {
        const { state, encoder, key, count } = ctx;
        for (let j = 0; j < count; j++) state.scores.set(key(j), i + j);
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
