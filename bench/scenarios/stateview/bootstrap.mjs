// Client-join cost: encodeAll + encodeAllView against a populated state.
import { defineDeep, makeDeepPlayer, encodeAllForView, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/bootstrap",
    unit: "ms/op",
    iterations: 50,
    reps: 7,
    variants: withCodecs([{ name: "default" }]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new codec.Encoder(state);
        const view = new lib.StateView();
        view.add(state);
        for (let j = 0; j < 100; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            if (j % 2 === 0) view.add(p); // view sees half the players
        }
        encoder.encode();
        encoder.discardChanges();
        return { codec, encoder, view };
    },
    run(ctx) {
        return ctx.codec.bytesOf(encodeAllForView(ctx.codec, ctx.encoder, ctx.view));
    },
};
