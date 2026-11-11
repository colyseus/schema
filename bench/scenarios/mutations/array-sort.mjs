// ArraySchema.sort(), encoded every tick — the leaderboard pattern: scores
// change, the board re-sorts. "swap" nudges one entry past a neighbour, "still"
// changes a score without changing the order, "flip" reverses the whole order.
// "push-sort-pop" adds an entry, sorts and drops the last one in one tick
// (5.x ships that as a full CLEAR + re-ADD on ref arrays since #249).
import { setAt, setBufferSize } from "../../lib/fixtures.mjs";

export default {
    name: "mutations/array-sort",
    unit: "ms/tick",
    reps: 7,
    variants: [
        { name: "refs-50-swap", kind: "refs", op: "swap", size: 50, iterations: 5000 },
        { name: "refs-50-still", kind: "refs", op: "still", size: 50, iterations: 5000 },
        { name: "refs-500-swap", kind: "refs", op: "swap", size: 500, iterations: 1000 },
        { name: "refs-500-flip", kind: "refs", op: "flip", size: 500, iterations: 1000 },
        { name: "refs-50-push-sort-pop", kind: "refs", op: "push-sort-pop", size: 50, iterations: 2000 },
        { name: "nums-500-swap", kind: "nums", op: "swap", size: 500, iterations: 1000 },
        { name: "nums-500-flip", kind: "nums", op: "flip", size: 500, iterations: 1000 },
    ],
    setup(lib, variant) {
        setBufferSize(lib);
        class Entry extends lib.Schema {
            constructor() {
                super(...arguments);
                this.name = "";
                this.score = 0;
            }
        }
        lib.type("string")(Entry.prototype, "name", undefined);
        lib.type("number")(Entry.prototype, "score", undefined);

        class BoardState extends lib.Schema {
            constructor() {
                super(...arguments);
                this.entries = new lib.ArraySchema();
                this.scores = new lib.ArraySchema();
            }
        }
        lib.type([Entry])(BoardState.prototype, "entries", undefined);
        lib.type(["number"])(BoardState.prototype, "scores", undefined);

        const state = new BoardState();
        const encoder = new lib.Encoder(state);
        let n = 0;
        const mk = (score) => { const e = new Entry(); e.name = "entry" + (n++); e.score = score; return e; };
        for (let i = 0; i < variant.size; i++) {
            if (variant.kind === "refs") state.entries.push(mk(variant.size * 10 - i * 10));
            else state.scores.push(variant.size * 10 - i * 10);
        }
        encoder.encode();
        encoder.discardChanges();

        const desc = variant.kind === "refs" ? (a, b) => b.score - a.score : (a, b) => b - a;
        const asc = variant.kind === "refs" ? (a, b) => a.score - b.score : (a, b) => a - b;
        return { arr: variant.kind === "refs" ? state.entries : state.scores, kind: variant.kind, op: variant.op, size: variant.size, encoder, mk, desc, asc };
    },
    run(ctx, i) {
        const { arr, kind, op, size } = ctx;
        const j = (i * 7) % size;
        if (op === "swap") {
            const delta = (i & 1) ? 15 : -15; // past one neighbour
            if (kind === "refs") arr[j].score += delta; else setAt(arr, j, arr[j] + delta);
            arr.sort(ctx.desc);
        } else if (op === "still") {
            arr[0].score += 1; // the leader extends its lead
            arr.sort(ctx.desc);
        } else if (op === "flip") {
            arr.sort((i & 1) ? ctx.asc : ctx.desc);
        } else {
            arr.push(ctx.mk(arr[j].score + 5));
            arr.sort(ctx.desc);
            arr.pop();
        }
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
};
