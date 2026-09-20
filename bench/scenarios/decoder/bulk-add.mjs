// Decode side of the root `bench_encode.js` workload (instance creation +
// refId registration per decoded ref).
//   turnover    frames that drop the 50 oldest Tree players and add 50 new ones
//               (3650 new instances per frame, room stays at 500); frames are
//               consumed exactly once, so the list is sized to plan.totalRuns
//   bootstrap   full-state decode of the 500-player room into a fresh Decoder
import { buildTreeState, genTreeTurnoverFrames } from "../../lib/fixtures.mjs";

const BATCH = 50;
const ROOM = 500;

export default {
    name: "decoder/bulk-add",
    unit: "ms/op",
    reps: 5,
    variants: [
        { name: "turnover", bootstrap: false, iterations: 40 },
        { name: "bootstrap", bootstrap: true, iterations: 10 },
    ],
    setup(lib, variant, plan) {
        const built = buildTreeState(lib, ROOM);
        const { state, encoder, State } = built;
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        if (variant.bootstrap) return { lib, State, bootstrap, fresh: true };
        const frames = genTreeTurnoverFrames(built, state, encoder, plan.totalRuns, ROOM, BATCH);
        const decoder = new lib.Decoder(new State());
        decoder.decode(bootstrap);
        return { decoder, frames, fresh: false };
    },
    run(ctx, i) {
        if (ctx.fresh) {
            new ctx.lib.Decoder(new ctx.State()).decode(ctx.bootstrap);
            return ctx.bootstrap.byteLength;
        }
        ctx.decoder.decode(ctx.frames[i]);
        return ctx.frames[i].byteLength;
    },
};
