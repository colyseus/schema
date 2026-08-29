// Ring-buffer on a @view-filtered ArraySchema<Schema> — the shape from
// issue #231 (chat/feed backlog, oldest shifted out per tick, per-client
// visibility). This is the one case that pays for keeping children's
// cached wire slot in step with the array, since only a filtered array
// has that slot read back (StateView.addParentOf / remove).
import { tickViews, codecOf } from "../../lib/fixtures.mjs";

const N_VIEWS = 4;

export default {
    name: "stateview/array-reindex",
    unit: "ms/tick",
    reps: 7,
    variants: [
        { name: "shift-100", size: 100, head: true, iterations: 2000 },
        { name: "shift-1000", size: 1000, head: true, iterations: 500 },
        // control: same churn off the tail, where compaction moves one slot
        { name: "pop-1000", size: 1000, head: false, iterations: 500 },
    ],
    setup(lib, variant) {
        const codec = codecOf(lib);
        class Row extends lib.Schema {
            constructor() {
                super(...arguments);
                this.text = "";
            }
        }
        lib.type("string")(Row.prototype, "text", undefined);

        class State extends lib.Schema {
            constructor() {
                super(...arguments);
                this.rows = new lib.ArraySchema();
            }
        }
        lib.type([Row])(State.prototype, "rows", undefined);
        lib.view()(State.prototype, "rows");

        const state = new State();
        const encoder = new lib.Encoder(state);
        const mk = (i) => { const r = new Row(); r.text = "row" + i; return r; };
        for (let i = 0; i < variant.size; i++) state.rows.push(mk(i));

        const views = [];
        for (let v = 0; v < N_VIEWS; v++) {
            const view = new lib.StateView();
            for (const row of state.rows) view.add(row);
            views.push(view);
        }
        tickViews(codec, encoder, views);
        return { codec, state, encoder, views, mk, head: variant.head };
    },
    run(ctx, i) {
        const rows = ctx.state.rows;
        if (ctx.head) { rows.shift(); } else { rows.pop(); }
        const row = ctx.mk(1000 + i);
        rows.push(row);
        for (let v = 0; v < N_VIEWS; v++) ctx.views[v].add(row);
        return tickViews(ctx.codec, ctx.encoder, ctx.views);
    },
};
