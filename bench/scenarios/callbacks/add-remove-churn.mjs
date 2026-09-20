// onAdd/onRemove dispatch under entity churn, with re-listen inside onAdd
// (the idiomatic Colyseus pattern). Frames consumed once — sized to plan.
import { buildBloatState, genChurnFrames } from "../../lib/fixtures.mjs";

export default {
    name: "callbacks/add-remove-churn",
    unit: "ms/frame",
    iterations: 200,
    reps: 5,
    // 2000, not 50: these frames take 20–45 µs and the decode path needs ~1500 of them to
    // reach the optimizing tier; a short window measured tier-up, not steady state (a build
    // that is 6–11 % faster at steady state read +12…+20 % slower — bench/v6-results.md).
    warmup: 2000,
    setup(lib, _variant, plan) {
        const { state, encoder, State, Player } = buildBloatState(lib, 100);
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const cycles = Math.ceil(plan.totalRuns / 2) + 1;
        const frames = genChurnFrames(lib, Player, state, encoder, cycles, 100, 10);
        const decoder = new lib.Decoder(new State());

        const counters = { onAdd: 0, onRemove: 0, listen: 0 };
        const $ = lib.Callbacks.get(decoder);
        $.onAdd("players", (player) => {
            counters.onAdd++;
            $.listen(player.position, "x", () => { counters.listen++; });
        });
        $.onRemove("players", () => { counters.onRemove++; });

        decoder.decode(bootstrap);
        return { decoder, frames, counters };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i]);
    },
    teardown(ctx) {
        if (ctx.counters.onAdd === 0 || ctx.counters.onRemove === 0) {
            throw new Error("churn callbacks never fired — registration is broken");
        }
    },
};
