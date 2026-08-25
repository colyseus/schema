// End-to-end room tick: 1 encoder + 10 view-clients, each with its own
// Reflection-built Decoder and Callbacks.get() listeners.
// Per tick: mutate → shared encode → per-view encode → 10 decodes → dispatch.
import { defineDeep, makeDeepPlayer, encodeAllForView } from "../../lib/fixtures.mjs";

const N_CLIENTS = 10;

export default {
    name: "e2e/room-tick",
    unit: "ms/tick",
    gate: true,
    budget: { default: 0.12 }, // ~2x baseline median (34ec6f7)
    iterations: 300,
    reps: 7,
    setup(lib) {
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        const players = [];
        const views = [];
        for (let v = 0; v < N_CLIENTS; v++) {
            const view = new lib.StateView();
            view.add(state);
            views.push(view);
        }
        for (let j = 0; j < 50; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            p.name = `p${j}`;
            players.push(p);
            views[j % N_CLIENTS].add(p);
        }

        const counters = { onAdd: 0, listen: 0 };
        const handshake = lib.Reflection.encode(encoder);
        const clients = views.map((view) => {
            const decoder = lib.Reflection.decode(handshake);
            const $ = lib.Callbacks.get(decoder);
            $.onAdd("players", (player) => {
                counters.onAdd++;
                $.listen(player.position, "x", () => { counters.listen++; });
                $.listen(player.position, "y", () => { counters.listen++; });
            });
            decoder.decode(encodeAllForView(encoder, view));
            return { view, decoder };
        });
        encoder.discardChanges();
        return { state, encoder, players, clients, counters };
    },
    run(ctx, i) {
        const { state, encoder, players, clients } = ctx;
        for (let j = 0; j < 10; j++) {
            const p = players[(i + j) % players.length];
            p.position.x++;
            p.position.y++;
            p.privateGold = i;
        }
        state.currentTurn = `t${i}`;

        const it = { offset: 0 };
        encoder.encode(it);
        const sharedOffset = it.offset;
        let bytes = 0;
        for (let c = 0; c < clients.length; c++) {
            const encoded = encoder.encodeView(clients[c].view, sharedOffset, it);
            bytes += encoded.byteLength;
            clients[c].decoder.decode(encoded);
        }
        encoder.discardChanges();
        return bytes;
    },
    teardown(ctx) {
        if (ctx.counters.onAdd === 0 || ctx.counters.listen === 0) {
            throw new Error("e2e callbacks never fired");
        }
    },
};
