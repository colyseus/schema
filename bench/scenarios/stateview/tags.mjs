// Custom numeric view tags: fields tagged @view(1)/@view(2), each client
// subscribed to one tag (bench_view_tags.js pattern — exercises hasTagOnTree).
import { setBufferSize, tickViews } from "../../lib/fixtures.mjs";

export default {
    name: "stateview/tags",
    unit: "ms/tick",
    iterations: 500,
    reps: 7,
    setup(lib) {
        setBufferSize(lib);
        class TagPlayer extends lib.Schema {}
        lib.type("number")(TagPlayer.prototype, "x", undefined);
        lib.type("number")(TagPlayer.prototype, "y", undefined);
        lib.type("number")(TagPlayer.prototype, "gold", undefined);
        lib.view(1)(TagPlayer.prototype, "gold", undefined);
        lib.type("string")(TagPlayer.prototype, "secret", undefined);
        lib.view(2)(TagPlayer.prototype, "secret", undefined);

        class TagState extends lib.Schema {
            constructor() {
                super(...arguments);
                this.players = new lib.MapSchema();
            }
        }
        lib.type({ map: TagPlayer })(TagState.prototype, "players", undefined);

        const state = new TagState();
        const encoder = new lib.Encoder(state);
        const players = [];
        for (let j = 0; j < 100; j++) {
            const p = new TagPlayer();
            p.x = j; p.y = j; p.gold = j; p.secret = `s${j}`;
            state.players.set(`p${j}`, p);
            players.push(p);
        }
        const views = [];
        for (let v = 0; v < 10; v++) {
            const view = new lib.StateView();
            view.add(state);
            const tag = (v % 2) + 1;
            for (const p of players) view.add(p, tag);
            views.push(view);
        }
        tickViews(encoder, views);
        return { state, encoder, views, players };
    },
    run(ctx, i) {
        const { encoder, views, players } = ctx;
        for (let j = 0; j < 20; j++) {
            const p = players[j];
            p.x++;
            p.gold = i;      // tag 1
            p.secret = `s${i & 7}`; // tag 2
        }
        return tickViews(encoder, views);
    },
};
