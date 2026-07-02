// Listener density with the state strategy: how does dispatch scale from
// zero registered listeners (but triggerChanges attached — pays the
// DataChange-allocation path) to 1% to 100% of players listened?
import { buildBloatState, genHeavyFrames } from "../../lib/fixtures.mjs";

export default {
    name: "callbacks/density",
    unit: "ms/frame",
    variants: [
        { name: "none", every: 0 },
        { name: "sparse1pct", every: 100 },
        { name: "dense", every: 1 },
    ],
    iterations: 400,
    reps: 7,
    setup(lib, variant) {
        const { state, encoder, State } = buildBloatState(lib, 1000);
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const frames = genHeavyFrames(state, encoder, 200, 1000);
        const decoder = new lib.Decoder(new State());

        const counters = { listen: 0 };
        const $ = lib.Callbacks.get(decoder); // attaches triggerChanges even with 0 listeners
        if (variant.every > 0) {
            let n = 0;
            $.onAdd("players", (player) => {
                if (n++ % variant.every === 0) {
                    $.listen(player.position, "x", () => { counters.listen++; });
                    $.listen(player.position, "y", () => { counters.listen++; });
                }
            });
        }
        decoder.decode(bootstrap);
        return { decoder, frames, counters };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i % ctx.frames.length]);
    },
};
