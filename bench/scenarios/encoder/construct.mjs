// Entity construction into a live encoder: 5000 players per run (bench_bloat M4).
import { defineBloat, makeBloatPlayer } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/construct",
    unit: "µs/entity",
    iterations: 5,
    reps: 7,
    warmup: 2,
    valueScale: 1000 / 5000, // ms per 5000-entity run -> µs/entity
    setup(lib) {
        return { lib, ...defineBloat(lib) };
    },
    run(ctx) {
        const state = new ctx.State();
        const encoder = new ctx.lib.Encoder(state);
        for (let i = 0; i < 5000; i++) {
            state.players.set(`p${i}`, makeBloatPlayer(ctx.Player, i));
        }
        return state.players.size === 5000 ? 0 : -1; // sink guard, no bytes metric
    },
};
