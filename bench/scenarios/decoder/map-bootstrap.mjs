// Full-state bootstrap decode of a map snapshot: fresh Decoder per run.
// Map<Player> × 1000 (instance creation) and Map<number> × 10000 (the body
// loop: key read + Map.set per entry), string vs number keys.
import { buildMapState } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/map-bootstrap",
    unit: "ms/op",
    iterations: 30,
    reps: 7,
    variants: [
        { name: "players-str-1000", key: "string", players: 1000, scores: 0 },
        { name: "players-num-1000", key: "number", players: 1000, scores: 0 },
        { name: "scores-str-10000", key: "string", players: 0, scores: 10000 },
        { name: "scores-num-10000", key: "number", players: 0, scores: 10000 },
    ],
    setup(lib, variant) {
        const { encoder, State } = buildMapState(lib, variant.key, variant.players, variant.scores);
        const bootstrap = encoder.encodeAll().slice();
        return { lib, State, bootstrap };
    },
    run(ctx) {
        const decoder = new ctx.lib.Decoder(new ctx.State());
        decoder.decode(ctx.bootstrap);
        return ctx.bootstrap.byteLength;
    },
};
