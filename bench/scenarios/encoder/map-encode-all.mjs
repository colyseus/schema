// Full-state snapshot of a map: Map<Player> × 1000 (nested bodies) and
// Map<number> × 10000 (the body loop itself), string vs number keys.
import { buildMapState } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/map-encode-all",
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
        const { encoder } = buildMapState(lib, variant.key, variant.players, variant.scores);
        encoder.encode();
        encoder.discardChanges();
        return { encoder };
    },
    run(ctx) {
        return ctx.encoder.encodeAll().byteLength;
    },
};
