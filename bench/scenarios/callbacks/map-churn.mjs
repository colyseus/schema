// onAdd / onRemove dispatch under map churn (Map<Player> × 1000, delete-10 /
// re-add-10 per cycle) with the idiomatic re-listen inside onAdd, plus
// onChange over a Map<number> replace frame. String vs number keys reach the
// callbacks as the key argument. Frames consumed once — sized to plan.
import { buildMapState, genMapChurnFrames } from "../../lib/fixtures.mjs";

export default {
    name: "callbacks/map-churn",
    unit: "ms/frame",
    iterations: 200,
    reps: 5,
    // 2000, not 50: these frames take 20–45 µs and the decode path needs ~1500 of them to
    // reach the optimizing tier; a short window measured tier-up, not steady state (a build
    // that is 6–11 % faster at steady state read +12…+20 % slower — bench/v6-results.md).
    warmup: 2000,
    variants: [
        { name: "str", key: "string" },
        { name: "num", key: "number" },
    ],
    setup(lib, variant, plan) {
        const shapes = buildMapState(lib, variant.key, 1000);
        const { state, encoder, State } = shapes;
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const cycles = Math.ceil(plan.totalRuns / 2) + 1;
        const frames = genMapChurnFrames(shapes, state, encoder, cycles, 1000, 10);
        const decoder = new lib.Decoder(new State());

        const counters = { onAdd: 0, onRemove: 0, listen: 0, keys: 0 };
        const $ = lib.Callbacks.get(decoder);
        $.onAdd("players", (player, key) => {
            counters.onAdd++;
            if (key !== undefined) counters.keys++;
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
        if (ctx.counters.onAdd === 0 || ctx.counters.onRemove === 0 || ctx.counters.keys !== ctx.counters.onAdd) {
            throw new Error("map churn callbacks never fired (or fired without a key) — registration is broken");
        }
    },
};
