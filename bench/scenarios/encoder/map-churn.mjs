// Entity churn over a Map<Player>: delete 10 keys, encode, re-add 10, encode
// (ADD with inline bodies + DELETE ops). String keys (8-char, session-id
// sized) vs number keys (`key: "number"`; a build without typed keys
// stringifies them). `str-16`: a map smaller than the churn window's reach
// (wire indexes pass 32 within 2 cycles unless recycled). `same-tick`: delete
// 10 and add 10 other keys in ONE tick (key ids rotate through n + 10).
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
        { name: "str-16", key: "string", n: 16 },
        { name: "same-tick", key: "string", n: 100, sameTick: true },
    ],
    setup(lib, variant) {
        const { state, encoder, Player, key } = buildMapState(lib, variant.key, variant.n);
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder, Player, key, n: variant.n, sameTick: variant.sameTick === true };
    },
    run(ctx, i) {
        const { state, encoder, Player, key, n } = ctx;
        if (ctx.sameTick) {
            const ring = n + 10;
            for (let j = 0; j < 10; j++) state.players.delete(key((i * 10 + j) % ring));
            for (let j = 0; j < 10; j++) state.players.set(key((i * 10 + n + j) % ring), makeMapPlayer(Player, i * 10 + j));
            const bytes = encoder.encode().byteLength;
            encoder.discardChanges();
            return bytes;
        }
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
