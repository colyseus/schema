// Callback dispatch strategies over identical heavy frames. Compare against
// decoder/tick (no triggerChanges at all) to isolate total listener cost.
//   raw    — getRawChangesCallback: DataChange[] firehose, zero dispatch
//   state  — Callbacks.get() StateCallbackStrategy (dense: onAdd + 2 listens/player)
//   legacy — getDecoderStateCallbacks proxy (same registrations)
import { buildBloatState, genHeavyFrames, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "callbacks/strategies",
    unit: "ms/frame",
    gate: true,
    budget: { raw: 1.4, state: 1.6, legacy: 1.7 }, // ~2x baseline medians (34ec6f7)
    variants: withCodecs([
        { name: "raw", strategy: "raw", iterations: 400 },
        { name: "state", strategy: "state", iterations: 400 },
        { name: "legacy", strategy: "legacy", iterations: 400 },
    ]),
    reps: 7,
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const { state, encoder, State } = buildBloatState(lib, 1000, codec);
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();
        const frames = genHeavyFrames(state, encoder, 200, 1000);
        const decoder = new codec.Decoder(new State());

        const counters = { onAdd: 0, listen: 0, raw: 0 };
        if (variant.strategy === "raw") {
            lib.getRawChangesCallback(decoder, (changes) => { counters.raw += changes.length; });
        } else if (variant.strategy === "state") {
            const $ = lib.Callbacks.get(decoder);
            $.onAdd("players", (player) => {
                counters.onAdd++;
                $.listen(player.position, "x", () => { counters.listen++; });
                $.listen(player.position, "y", () => { counters.listen++; });
            });
        } else {
            const $ = lib.getDecoderStateCallbacks(decoder);
            $(decoder.state).players.onAdd((player) => {
                counters.onAdd++;
                $(player.position).listen("x", () => { counters.listen++; });
                $(player.position).listen("y", () => { counters.listen++; });
            });
        }

        decoder.decode(bootstrap);
        return { decoder, frames, counters };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i % ctx.frames.length]);
    },
    teardown(ctx) {
        if (ctx.counters.onAdd === 0 && ctx.counters.raw === 0) {
            throw new Error("callbacks never fired — registration is broken");
        }
    },
};
