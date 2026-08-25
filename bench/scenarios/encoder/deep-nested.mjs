// Deep-nested growth tick (bench_encode.js / bench_view.js shape, no views):
// each run adds 50 players (10 items × 5 attributes each) then encodes the patch.
// Construction garbage + ADD-op encoding dominate — the canonical "make changes
// + encode" workload with historical baselines.
import { defineDeep, makeDeepPlayer, KEY } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/deep-nested",
    unit: "ms/tick",
    iterations: 20,
    reps: 5,
    warmup: 5,
    setup(lib) {
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        return { state, encoder, shapes };
    },
    run(ctx, i) {
        const { state, encoder, shapes } = ctx;
        for (let j = 0; j < 50; j++) {
            const player = makeDeepPlayer(shapes, j);
            const key = `p-${KEY(i * 50 + j)}`;
            state.players.set(key, player);
            player.name = key;
        }
        state.currentTurn = `turn-${i}`;
        state.adminSecret = `admin-${i}`;
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
