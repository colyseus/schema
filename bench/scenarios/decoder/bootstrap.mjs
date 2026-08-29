// Full-state bootstrap decode: fresh Decoder + 1000-entity snapshot per run.
// Allocation-heavy by design (instance creation, addRef, collections).
import { buildBloatState, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/bootstrap",
    unit: "ms/op",
    iterations: 30,
    reps: 7,
    variants: withCodecs([{ name: "default" }]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const { encoder, State } = buildBloatState(lib, 1000, codec);
        const bootstrap = encoder.encodeAll().slice();
        return { codec, State, bootstrap };
    },
    run(ctx) {
        const decoder = new ctx.codec.Decoder(new ctx.State());
        decoder.decode(ctx.bootstrap);
        return ctx.bootstrap.byteLength;
    },
};
