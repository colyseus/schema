// Turn-based room: tiny state (64-cell board, 4 players), rare small changes,
// many clients without views (everyone gets the same bytes).
//   enc            — encode bytes/time of one move
//   broadcast-100  — one encode + 100 clients decoding the same frame
//   broadcast-1000 — one encode + 1000 clients
import { codecOf, withCodecs, defineTurnBased, buildTurnBased, makeFullClient } from "../../lib/realworld.mjs";

function move(state, players, i) {
    state.board[i % 64] = 1 + (i % 3);
    state.currentTurn = `p${i & 3}`;
    if ((i & 3) === 3) state.round++;
    if ((i & 15) === 15) players[i & 3].score += 10;
}

export default {
    name: "realworld/turn-based",
    unit: "µs/tick",
    valueScale: 1000,
    reps: 7,
    variants: withCodecs([
        { name: "enc", clients: 0, iterations: 5000 },
        { name: "broadcast-100", clients: 100, iterations: 500 },
        { name: "broadcast-1000", clients: 1000, iterations: 100 },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const shapes = defineTurnBased(lib);
        const { state, encoder } = buildTurnBased(lib, codec, shapes, { players: 4 });
        encoder.discardChanges();
        const players = [];
        state.players.forEach((p) => players.push(p));
        const clients = [];
        for (let c = 0; c < variant.clients; c++) clients.push(makeFullClient(lib, codec, encoder));
        return { codec, state, encoder, players, clients };
    },
    run(ctx, i) {
        const { state, encoder, players, clients } = ctx;
        move(state, players, i);
        const encoded = encoder.encode();
        for (let c = 0; c < clients.length; c++) clients[c].decode(encoded);
        encoder.discardChanges();
        return encoded.byteLength * Math.max(1, clients.length);
    },
};
