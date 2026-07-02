// Full-state bootstrap decode: fresh Decoder + 1000-entity snapshot per run.
// Allocation-heavy by design (instance creation, addRef, collections).
import { buildBloatState } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/bootstrap",
    unit: "ms/op",
    iterations: 30,
    reps: 7,
    setup(lib) {
        const { encoder, State } = buildBloatState(lib, 1000);
        const bootstrap = encoder.encodeAll().slice();
        return { lib, State, bootstrap };
    },
    run(ctx) {
        const decoder = new ctx.lib.Decoder(new ctx.State());
        decoder.decode(ctx.bootstrap);
        return ctx.bootstrap.byteLength;
    },
};
