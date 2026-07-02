// String field mutation: rotate names of lengths 4..64 across 100 players/tick
// (utf8 length + write path — dominant for player names / chat-like payloads).
import { buildBloatState } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/string-heavy",
    unit: "ms/tick",
    iterations: 3000,
    reps: 7,
    setup(lib) {
        const { state, encoder } = buildBloatState(lib, 1000);
        encoder.encode();
        encoder.discardChanges();
        const names = [];
        for (let len = 4; len <= 64; len += 4) names.push("n".repeat(len - 2) + "0!");
        return { state, encoder, names };
    },
    run(ctx, i) {
        const { state, encoder, names } = ctx;
        for (let j = 0; j < 100; j++) {
            state.players.get(`p${j}`).name = names[(i + j) % names.length];
        }
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
