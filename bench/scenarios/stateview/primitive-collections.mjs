// Primitive collections under a @view-gated parent, each visible to one view
// out of many: every player sees only their own inventory, and every tick
// dirties a primitive map on each of their items. Prices how a view that
// can't see the parent rejects the collection.
import { tickViews, codecOf, field } from "../../lib/fixtures.mjs";

const ITEMS = 4;

export default {
    name: "stateview/primitive-collections",
    unit: "ms/tick",
    reps: 7,
    variants: [
        { name: "p64", players: 64, iterations: 1000 },
        { name: "p256", players: 256, iterations: 250 },
    ],
    setup(lib, variant) {
        const codec = codecOf(lib);
        class Item extends lib.Schema { constructor() { super(); this.id = 0; this.tags = new lib.MapSchema(); } }
        field(lib, Item, "id", "number");
        field(lib, Item, "tags", { map: "number" });
        class Inventory extends lib.Schema { constructor() { super(); this.items = new lib.ArraySchema(); } }
        field(lib, Inventory, "items", [Item]);
        class Player extends lib.Schema { constructor() { super(); this.name = ""; this.inventory = new Inventory(); } }
        field(lib, Player, "name", "string");
        field(lib, Player, "inventory", Inventory, true);
        class State extends lib.Schema { constructor() { super(); this.players = new lib.MapSchema(); } }
        field(lib, State, "players", { map: Player });

        const state = new State();
        const encoder = new lib.Encoder(state);
        const items = [];
        const views = [];
        for (let p = 0; p < variant.players; p++) {
            const player = new Player();
            player.name = "p" + p;
            for (let k = 0; k < ITEMS; k++) {
                const item = new Item();
                item.id = k;
                for (let t = 0; t < 4; t++) item.tags.set("t" + t, t);
                player.inventory.items.push(item);
                items.push(item);
            }
            state.players.set("p" + p, player);
            const view = new lib.StateView();
            view.add(player.inventory);
            views.push(view);
        }
        tickViews(codec, encoder, views);
        return { codec, encoder, items, views };
    },
    run(ctx, i) {
        const items = ctx.items;
        const key = "t" + (i & 3);
        for (let k = 0; k < items.length; k++) items[k].tags.set(key, i);
        return tickViews(ctx.codec, ctx.encoder, ctx.views);
    },
};
