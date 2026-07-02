// Steady-state decode: replay pre-generated heavy frames (every player
// x++/y++/scores[0] per frame) into a bootstrapped decoder. No listeners —
// this is the pure-decoder baseline (zero DataChange allocation path).
import { buildBloatState, genHeavyFrames } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/tick",
    unit: "ms/frame",
    gate: true,
    budget: { default: 1.3 }, // ~2x baseline median (34ec6f7)
    iterations: 400,
    reps: 7,
    setup(lib) {
        const { state, encoder, State } = buildBloatState(lib, 1000);
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const frames = genHeavyFrames(state, encoder, 200, 1000);
        const decoder = new lib.Decoder(new State());
        decoder.decode(bootstrap);
        return { decoder, frames };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i % ctx.frames.length]);
    },
};
