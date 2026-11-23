// Reads through the ArraySchema Proxy `get` trap — no mutation, no encode
// (except "tick"). Every `arr.length`, `arr.find`, and every `this.items`
// inside a method arrives at the trap as a property *name*; `arr[i]` arrives
// as an index string. "length-loop" re-reads `.length` on each step (the plain
// `for` loop), "index-loop" caches it and so isolates the index path,
// "at"/"find"/"for-of" go through methods, and "tick" is the game-loop shape:
// walk the array, nudge every child, encode.
import { setBufferSize } from "../../lib/fixtures.mjs";

export default {
    name: "reads/array-proxy",
    unit: "µs/pass",
    valueScale: 1000,
    reps: 7,
    variants: [
        { name: "nums-100-length-loop", kind: "nums", op: "length-loop", size: 100, iterations: 20000 },
        { name: "nums-100-index-loop", kind: "nums", op: "index-loop", size: 100, iterations: 20000 },
        { name: "refs-100-length-loop", kind: "refs", op: "length-loop", size: 100, iterations: 20000 },
        { name: "refs-100-index-loop", kind: "refs", op: "index-loop", size: 100, iterations: 20000 },
        { name: "nums-100-at", kind: "nums", op: "at", size: 100, iterations: 20000 },
        { name: "refs-10-find", kind: "refs", op: "find", size: 10, iterations: 100000 },
        { name: "refs-10-for-of", kind: "refs", op: "for-of", size: 10, iterations: 100000 },
        { name: "refs-100-tick", kind: "refs", op: "tick", size: 100, iterations: 5000 },
    ],
    setup(lib, variant) {
        setBufferSize(lib);
        class Entry extends lib.Schema {
            constructor() {
                super(...arguments);
                this.score = 0;
            }
        }
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
        let expected = 0;
        for (let i = 0; i < variant.size; i++) {
            const score = i + 1;
            expected += score;
            if (variant.kind === "refs") {
                const entry = new Entry();
                entry.score = score;
                state.entries.push(entry);
            } else {
                state.scores.push(score);
            }
        }
        encoder.encode();
        encoder.discardChanges();

        const last = variant.size;
        return {
            arr: variant.kind === "refs" ? state.entries : state.scores,
            kind: variant.kind, op: variant.op, size: variant.size, encoder,
            isLast: (entry) => entry.score === last,
            // "find" reads one entry per pass; every other op sums them all
            expected: variant.op === "find" ? last : expected,
            checked: variant.op !== "tick",
            sum: 0,
        };
    },
    run(ctx) {
        const { arr, kind, op } = ctx;
        let sum = 0;
        if (op === "length-loop") {
            if (kind === "refs") for (let i = 0; i < arr.length; i++) sum += arr[i].score;
            else for (let i = 0; i < arr.length; i++) sum += arr[i];
        } else if (op === "index-loop") {
            const length = arr.length;
            if (kind === "refs") for (let i = 0; i < length; i++) sum += arr[i].score;
            else for (let i = 0; i < length; i++) sum += arr[i];
        } else if (op === "at") {
            for (let i = 0, length = ctx.size; i < length; i++) sum += arr.at(i);
        } else if (op === "find") {
            sum = arr.find(ctx.isLast).score;
        } else if (op === "for-of") {
            for (const entry of arr) sum += entry.score;
        } else {
            for (let i = 0; i < arr.length; i++) arr[i].score += 1;
            const bytes = ctx.encoder.encode().byteLength;
            ctx.encoder.discardChanges();
            return bytes;
        }
        ctx.sum = sum;
    },
    teardown(ctx) {
        if (ctx.checked && ctx.sum !== ctx.expected) {
            throw new Error(`reads/array-proxy ${ctx.op}: read ${ctx.sum}, expected ${ctx.expected}`);
        }
    },
};
