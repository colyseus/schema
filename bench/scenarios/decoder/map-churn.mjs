// ADD/DELETE-heavy decode over a Map<Player> × 1000: replay churn frames
// (delete-10 / re-add-10 per cycle). Frames are consumed exactly once (refId
// reuse makes replay unsafe), so the frame list is sized to plan.totalRuns.
import { buildMapState, genMapChurnFrames } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/map-churn",
    unit: "ms/frame",
    iterations: 200,
    reps: 5,
    // 2000, not 50: these frames take 20–45 µs and the decode path needs ~1500 of them to
    // reach the optimizing tier; a short window measured tier-up, not steady state (a build
    // that is 6–11 % faster at steady state read +12…+20 % slower — bench/v6-results.md).
    warmup: 2000,
    variants: [
        { name: "str", key: "string" },
        { name: "num", key: "number" },
    ],
    setup(lib, variant, plan) {
        const shapes = buildMapState(lib, variant.key, 1000);
        const { state, encoder, State } = shapes;
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const cycles = Math.ceil(plan.totalRuns / 2) + 1;
        const frames = genMapChurnFrames(shapes, state, encoder, cycles, 1000, 10);
        const decoder = new lib.Decoder(new State());
        decoder.decode(bootstrap);
        return { decoder, frames };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i]);
        return ctx.frames[i].byteLength;
    },
};
