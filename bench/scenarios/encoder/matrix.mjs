// v5 vs v6 matrix: entity count × encode mode, bloat shape
// (`Map<Player{name, position{x,y}, scores[5]}>`). Patch ticks move the
// first `moving` players by fractional steps (float32 payloads, as in a game).
import { buildBloatState, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/matrix",
    unit: "ms/op",
    reps: 7,
    variants: withCodecs([
        { name: "full-1000", n: 1000, mode: "full", iterations: 40 },
        { name: "full-2000", n: 2000, mode: "full", iterations: 20 },
        { name: "patch10pct-1000", n: 1000, mode: "patch", moving: 100, iterations: 1500 },
        { name: "patch10pct-2000", n: 2000, mode: "patch", moving: 200, iterations: 800 },
        { name: "patch100pct-1000", n: 1000, mode: "patch", moving: 1000, iterations: 300 },
        { name: "patch100pct-2000", n: 2000, mode: "patch", moving: 2000, iterations: 150 },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const { state, encoder } = buildBloatState(lib, variant.n, codec);
        encoder.encode();
        encoder.discardChanges();
        const players = [];
        for (let i = 0; i < (variant.moving ?? 0); i++) players.push(state.players.get(`p${i}`));
        return { encoder, players, mode: variant.mode };
    },
    run(ctx, i) {
        const { encoder, players } = ctx;
        if (ctx.mode === "full") return encoder.encodeAll().byteLength;
        const dx = (i & 3) * 0.25 + 0.5;
        for (let j = 0; j < players.length; j++) {
            const pos = players[j].position;
            pos.x += dx;
            pos.y -= dx;
        }
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
