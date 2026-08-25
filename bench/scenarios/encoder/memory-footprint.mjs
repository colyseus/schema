// Retained heap for 1000 entities attached to a live encoder (bench_bloat M1).
// measure:"heap" — value is heapDeltaKb across the (single) run.
import { defineBloat, makeBloatPlayer } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/memory-footprint",
    unit: "KB",
    measure: "heap",
    iterations: 1,
    reps: 1,
    warmup: 0,
    setup(lib) {
        return { lib, ...defineBloat(lib), keep: null };
    },
    run(ctx) {
        const state = new ctx.State();
        const encoder = new ctx.lib.Encoder(state);
        for (let i = 0; i < 1000; i++) {
            state.players.set(`p${i}`, makeBloatPlayer(ctx.Player, i));
        }
        ctx.keep = { state, encoder }; // retain so heap delta reflects live footprint
    },
};
