// ADD/DELETE-heavy decode: replay churn frames (delete-10 / re-add-10 per
// cycle). Exercises garbageCollectDeletedRefs, instance creation, refId churn.
// Frames are consumed exactly once (refId reuse makes replay unsafe), so the
// frame list is sized to plan.totalRuns.
import { buildBloatState, genChurnFrames, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/churn",
    unit: "ms/frame",
    iterations: 200,
    reps: 5,
    // 2000, not 50: these frames take 20–45 µs and the decode path needs ~1500 of them to
    // reach the optimizing tier; a short window measured tier-up, not steady state (a build
    // that is 6–11 % faster at steady state read +12…+20 % slower — bench/v6-results.md).
    warmup: 2000,
    variants: withCodecs([{ name: "default" }]),
    setup(lib, variant, plan) {
        const codec = codecOf(lib, variant);
        const { state, encoder, State, Player } = buildBloatState(lib, 100, codec);
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const cycles = Math.ceil(plan.totalRuns / 2) + 1;
        const frames = genChurnFrames(lib, Player, state, encoder, cycles, 100, 10);
        const decoder = new codec.Decoder(new State());
        decoder.decode(bootstrap);
        return { decoder, frames };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i]);
    },
};
