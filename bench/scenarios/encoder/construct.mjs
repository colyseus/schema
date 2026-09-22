// Entity construction into a live encoder: 5000 players per run (bench_bloat M4).
import { defineBloat, makeBloatPlayer } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/construct",
    unit: "µs/entity",
    iterations: 5,
    reps: 7,
    // Warm-up comes from the harness minimum (run.mjs --min-warmup-ms).
    // V8 allocation-site pretenuring is a per-process lottery here: in 10–50 %
    // of processes the entity sites get pretenured and GC time per run jumps
    // ~2.5× (2.4 → 3.2 µs/entity), independent of the warm-up length. That
    // bimodality, not code, moved this row by ±5–20 % in A/A runs, so the
    // scenario measures the non-pretenured regime (LEADS/10-bench-harness.md).
    nodeFlags: ["--no-allocation-site-pretenuring"],
    warmup: 10, // ≥ 100 ms, and enough run() invocations for its own tier-up
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
