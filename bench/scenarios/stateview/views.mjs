// N-client per-view encode: shared pass + encodeView per client
// (mirrors test/Schema.ts encodeMultiple). Deep shape, 100 players,
// players distributed round-robin across views.
import { defineDeep, makeDeepPlayer, tickViews } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/views",
    unit: "ms/tick",
    gate: true,
    budget: { v1: 0.022, v10: 0.042, v50: 0.12 }, // ~2x baseline medians (34ec6f7)
    variants: [
        { name: "v1", clients: 1, iterations: 1000 },
        { name: "v10", clients: 10, iterations: 500 },
        { name: "v50", clients: 50, iterations: 150 },
    ],
    reps: 7,
    setup(lib, variant) {
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        const views = [];
        for (let v = 0; v < variant.clients; v++) {
            const view = new lib.StateView();
            view.add(state);
            views.push(view);
        }
        const players = [];
        for (let j = 0; j < 100; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            p.name = `p${j}`;
            players.push(p);
            views[j % views.length].add(p);
        }
        tickViews(encoder, views); // flush construction ops
        return { state, encoder, views, players };
    },
    run(ctx, i) {
        const { state, encoder, views, players } = ctx;
        for (let j = 0; j < 20; j++) {
            const p = players[j];
            p.position.x++;
            p.position.y++;
            p.privateGold = i; // view-tagged field
        }
        state.currentTurn = `t${i}`;
        return tickViews(encoder, views);
    },
};
