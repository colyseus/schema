// REPLACE-heavy decode over a Map<number> × 1000: every entry gets a new
// value per frame (replay-safe: no refIds involved).
import { buildMapState, genMapReplaceFrames } from "../../lib/fixtures.mjs";

const FRAMES = 64;

export default {
    name: "decoder/map-replace",
    unit: "ms/frame",
    iterations: 500,
    reps: 7,
    variants: [
        { name: "str-100pct", key: "string", count: 1000 },
        { name: "num-100pct", key: "number", count: 1000 },
    ],
    setup(lib, variant) {
        const shapes = buildMapState(lib, variant.key, 0, 1000);
        const { state, encoder, State } = shapes;
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const frames = genMapReplaceFrames(shapes, state, encoder, FRAMES, variant.count);
        const decoder = new lib.Decoder(new State());
        decoder.decode(bootstrap);
        return { decoder, frames };
    },
    run(ctx, i) {
        const frame = ctx.frames[i % FRAMES];
        ctx.decoder.decode(frame);
        return frame.byteLength;
    },
};
