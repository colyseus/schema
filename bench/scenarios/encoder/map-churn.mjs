// Entity churn over a Map<Player>: delete 10 keys, encode, re-add 10, encode
// (ADD with inline bodies + DELETE ops). String keys (8-char, session-id
// sized) vs number keys (`key: "number"`; a build without typed keys
// stringifies them).
import { buildMapState, makeMapPlayer } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/map-churn",
    unit: "ms/cycle",
    iterations: 1500,
    reps: 7,
    variants: [
        { name: "str-100", key: "string", n: 100 },
        { name: "str-1000", key: "string", n: 1000 },
        { name: "num-100", key: "number", n: 100 },
        { name: "num-1000", key: "number", n: 1000 },
    ],
    setup(lib, variant) {
        const { state, encoder, Player, key } = buildMapState(lib, variant.key, variant.n);
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder, Player, key, n: variant.n };
    },
    run(ctx, i) {
        const { state, encoder, Player, key, n } = ctx;
        for (let j = 0; j < 10; j++) state.players.delete(key((i * 10 + j) % n));
        let bytes = encoder.encode().byteLength;
        encoder.discardChanges();
        for (let j = 0; j < 10; j++) {
            const k = (i * 10 + j) % n;
            state.players.set(key(k), makeMapPlayer(Player, i * 10 + j));
        }
        bytes += encoder.encode().byteLength;
        encoder.discardChanges();
        return bytes;
    },
};
