// Entity add/remove churn over a 100-player map: delete 10, encode, re-add 10,
// encode (bench_bloat M7 — exercises Root linked list + refId pool).
import { buildBloatState, makeBloatPlayer, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/entity-churn",
    unit: "ms/cycle",
    iterations: 1500,
    reps: 7,
    variants: withCodecs([{ name: "default" }]),
    setup(lib, variant) {
        const { state, encoder, Player } = buildBloatState(lib, 100, codecOf(lib, variant));
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder, Player };
    },
    run(ctx, i) {
        const { state, encoder, Player } = ctx;
        for (let j = 0; j < 10; j++) state.players.delete(`p${(i * 10 + j) % 100}`);
        encoder.encode();
        encoder.discardChanges();
        for (let j = 0; j < 10; j++) {
            const key = `p${(i * 10 + j) % 100}`;
            state.players.set(key, makeBloatPlayer(Player, i * 10 + j));
        }
        const bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
