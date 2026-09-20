// Mutation-side cost of the root `bench_encode.js` workload, no wire: 50 Tree
// players (3650 tracked instances) per op.
//   construct      build the players detached and drop them (new + setters only)
//   attach-fresh   build + `players.set` (recursive setParent + refId assignment);
//                  the room grows every op, as the script's does
//   attach-steady  same, after deleting the 50 oldest players (room stays at 500,
//                  old-space and GC stay flat)
// attach cost = attach-* minus construct.
import { KEY, buildTreeState, defineTree, makeTreePlayer } from "../../lib/fixtures.mjs";

const BATCH = 50;
const ROOM = 500;

export default {
    name: "mutations/tree-build",
    unit: "ms/op",
    reps: 7,
    iterations: 20,
    warmup: 20,
    variants: [
        { name: "construct", mode: "construct" },
        { name: "attach-fresh", mode: "fresh" },
        { name: "attach-steady", mode: "steady" },
    ],
    setup(lib, variant) {
        if (variant.mode === "construct") return { mode: "construct", shapes: defineTree(lib) };
        const built = buildTreeState(lib, variant.mode === "steady" ? ROOM : 0);
        return { mode: variant.mode, shapes: built, state: built.state, encoder: built.encoder, oldest: 0, next: ROOM };
    },
    run(ctx) {
        const { shapes, mode } = ctx;
        if (mode === "construct") {
            let sum = 0;
            for (let j = 0; j < BATCH; j++) sum += makeTreePlayer(shapes, j).items.size;
            return sum === BATCH * 10 ? undefined : -1;
        }
        const players = ctx.state.players;
        if (mode === "steady") {
            for (let j = 0; j < BATCH; j++) players.delete(KEY(ctx.oldest++));
        }
        for (let j = 0; j < BATCH; j++) players.set(KEY(ctx.next++), makeTreePlayer(shapes, j));
        ctx.encoder.discardChanges();
        return undefined;
    },
};
