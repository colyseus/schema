// Client join (encodeAll + encodeAllView) on a public state with no @view fields:
// the view pass walks the whole tree but should emit nothing.
import { buildBloatState, encodeAllForView } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/public-join",
    unit: "ms/op",
    reps: 7,
    variants: [
        { name: "n1000", n: 1000, iterations: 200 },
        { name: "n5000", n: 5000, iterations: 15 },
    ],
    setup(lib, variant) {
        const { state, encoder } = buildBloatState(lib, variant.n);
        encoder.encode();
        encoder.discardChanges();
        const view = new lib.StateView();
        view.add(state);
        return { encoder, view };
    },
    run(ctx) {
        return encodeAllForView(ctx.encoder, ctx.view).byteLength;
    },
};
