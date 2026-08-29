// Steady-state patch encode: mutate K players' positions, encode, discard.
// Port of src/bench_bloat.ts measures 2/3 (historical: 0.0050ms/10-mut, 0.044ms/100-mut).
import { buildBloatState, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/steady-tick",
    unit: "ms/tick",
    gate: true,
    budget: { mut10: 0.004, mut100: 0.045 }, // ~2x baseline medians (34ec6f7)
    variants: withCodecs([
        { name: "mut10", mutations: 10, iterations: 5000 },
        { name: "mut100", mutations: 100, iterations: 1500 },
    ]),
    reps: 7,
    setup(lib, variant) {
        const { state, encoder } = buildBloatState(lib, 1000, codecOf(lib, variant));
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder, mutations: variant.mutations };
    },
    run(ctx) {
        const { state, encoder, mutations } = ctx;
        for (let j = 0; j < mutations; j++) {
            const p = state.players.get(`p${j}`);
            p.position.x++;
            p.position.y++;
        }
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
