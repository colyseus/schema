// Encode of one bulk-ADD tick of the root `bench_encode.js` workload: 50 new
// Tree players (3650 instances, all inline bodies) on top of a 500-player
// room. The tick is never discarded, so every op re-encodes the same pending
// changes — encode cost only, no construction in the timed region.
//   patch     encoder.encode() of the pending tick
//   full      encoder.encodeAll() of the whole room (550 players)
import { KEY, buildTreeState, makeTreePlayer } from "../../lib/fixtures.mjs";

const BATCH = 50;
const ROOM = 500;

export default {
    name: "encoder/bulk-add",
    unit: "ms/op",
    reps: 7,
    variants: [
        { name: "patch", full: false, iterations: 200 },
        { name: "full", full: true, iterations: 20 },
    ],
    setup(lib, variant) {
        const built = buildTreeState(lib, ROOM);
        for (let j = 0; j < BATCH; j++) built.state.players.set(KEY(ROOM + j), makeTreePlayer(built, j));
        return { encoder: built.encoder, full: variant.full };
    },
    run(ctx) {
        return (ctx.full ? ctx.encoder.encodeAll() : ctx.encoder.encode()).byteLength;
    },
};
