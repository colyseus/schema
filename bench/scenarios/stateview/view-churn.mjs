// Rolling visibility window: each tick every view add()s the next player and
// remove()s its oldest — exercises view.add subtree walk, DELETE emission,
// and per-view ADD encoding.
import { defineDeep, makeDeepPlayer, tickViews, codecOf } from "../../lib/fixtures.mjs";

const N_PLAYERS = 100;
const N_VIEWS = 10;
const WINDOW = 10;

export default {
    name: "stateview/view-churn",
    unit: "ms/tick",
    iterations: 500,
    reps: 7,
    setup(lib) {
        const codec = codecOf(lib);
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        const players = [];
        for (let j = 0; j < N_PLAYERS; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            players.push(p);
        }
        const views = [];
        for (let v = 0; v < N_VIEWS; v++) {
            const view = new lib.StateView();
            view.add(state);
            for (let w = 0; w < WINDOW; w++) view.add(players[(v * WINDOW + w) % N_PLAYERS]);
            views.push(view);
        }
        tickViews(codec, encoder, views);
        return { codec, encoder, views, players };
    },
    run(ctx, i) {
        const { codec, encoder, views, players } = ctx;
        for (let v = 0; v < N_VIEWS; v++) {
            const head = (v * WINDOW + WINDOW + i) % N_PLAYERS;
            const tail = (v * WINDOW + i) % N_PLAYERS;
            views[v].add(players[head]);
            views[v].remove(players[tail]);
        }
        return tickViews(codec, encoder, views);
    },
};
