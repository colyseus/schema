// Client join (encodeAll + encodeAllView) on a public state with no @view fields:
// the view pass walks the whole tree but should emit nothing.
import { buildBloatState, encodeAllForView, codecOf } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/public-join",
    unit: "ms/op",
    reps: 7,
    variants: [
        { name: "n1000", n: 1000, iterations: 200 },
        { name: "n5000", n: 5000, iterations: 15 },
    ],
    setup(lib, variant) {
        const codec = codecOf(lib);
        const { state, encoder } = buildBloatState(lib, variant.n, codec);
        encoder.encode();
        encoder.discardChanges();
        const view = new lib.StateView();
        view.add(state);
        return { codec, encoder, view };
    },
    run(ctx) {
        return ctx.codec.bytesOf(encodeAllForView(ctx.codec, ctx.encoder, ctx.view));
    },
};
