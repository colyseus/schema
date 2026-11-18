// @view(N) ref fields read by views that hold tag N, and by views that reached
// them through a nested add() without the tag ("opened" paths). Every tick
// dirties tagged primitive and ref fields, so each view pass runs the
// custom-tag filter on both hits and misses.
import { tickViews, codecOf, field } from "../../lib/fixtures.mjs";

const PLAYERS = 100;
const DIRTY = 25;
const VIEWS = 32;

export default {
    name: "stateview/opened-fields",
    unit: "ms/tick",
    iterations: 400,
    reps: 7,
    variants: [
        { name: "tagged", opened: 0 },
        { name: "mixed", opened: VIEWS / 2 },
        { name: "opened", opened: VIEWS },
    ],
    setup(lib, variant) {
        const codec = codecOf(lib);
        class Stats extends lib.Schema { constructor() { super(); this.hp = 0; } }
        field(lib, Stats, "hp", "number");
        class Gear extends lib.Schema { constructor() { super(); this.n = 0; } }
        field(lib, Gear, "n", "number");
        class Bag extends lib.Schema { constructor() { super(); this.gear = new lib.ArraySchema(); } }
        field(lib, Bag, "gear", [Gear]);
        class Player extends lib.Schema {
            constructor() { super(); this.x = 0; this.gold = 0; this.stats = new Stats(); this.bag = new Bag(); }
        }
        field(lib, Player, "x", "number");
        field(lib, Player, "gold", "number", 1);
        field(lib, Player, "stats", Stats, 1);
        field(lib, Player, "bag", Bag, 2);
        class State extends lib.Schema { constructor() { super(); this.players = new lib.MapSchema(); } }
        field(lib, State, "players", { map: Player });

        const state = new State();
        const encoder = new lib.Encoder(state);
        const players = [];
        for (let p = 0; p < PLAYERS; p++) {
            const player = new Player();
            player.bag.gear.push(new Gear());
            state.players.set("p" + p, player);
            players.push(player);
        }
        const views = [];
        for (let v = 0; v < VIEWS; v++) {
            const view = new lib.StateView();
            view.add(state);
            for (const player of players) {
                if (v < variant.opened) view.add(player.bag.gear[0]); // no tag: opens `bag`
                else view.add(player, 1);
            }
            views.push(view);
        }
        tickViews(codec, encoder, views);
        return { codec, encoder, players, views, Stats };
    },
    run(ctx, i) {
        const { players, Stats } = ctx;
        for (let k = 0; k < DIRTY; k++) {
            const player = players[(i * DIRTY + k) % PLAYERS];
            player.x++;
            player.gold = i;
            player.stats.hp++;
            player.bag.gear[0].n++;
            if ((k & 3) === 0) player.stats = new Stats(); // dirties the ref field itself
        }
        return tickViews(ctx.codec, ctx.encoder, ctx.views);
    },
};
