// Client-join cost: encodeAll + encodeAllView against a populated state.
import { defineDeep, makeDeepPlayer, encodeAllForView } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/bootstrap",
    unit: "ms/op",
    iterations: 50,
    reps: 7,
    setup(lib) {
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        const view = new lib.StateView();
        view.add(state);
        for (let j = 0; j < 100; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            if (j % 2 === 0) view.add(p); // view sees half the players
        }
        encoder.encode();
        encoder.discardChanges();
        return { encoder, view };
    },
    run(ctx) {
        return encodeAllForView(ctx.encoder, ctx.view).byteLength;
    },
};
