// Heavy tick: every player mutates (x, y, scores[0]) before each encode.
import { buildBloatState } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/heavy-tick",
    unit: "ms/tick",
    iterations: 300,
    reps: 7,
    setup(lib) {
        const { state, encoder } = buildBloatState(lib, 1000);
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder };
    },
    run(ctx, i) {
        const { state, encoder } = ctx;
        for (let j = 0; j < 1000; j++) {
            const p = state.players.get(`p${j}`);
            p.position.x++;
            p.position.y++;
            p.scores[0] = i;
        }
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
