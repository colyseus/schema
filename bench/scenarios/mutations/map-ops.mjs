// MapSchema API cost on the encoder side, no wire: reads (get / has /
// forEach / for-of / keys) over 1000 entries, a REPLACE-recording `set` on
// every entry, and add + delete of 100 fresh keys per op. String (8-char)
// vs number keys.
import { buildMapState, makeMapPlayer } from "../../lib/fixtures.mjs";

const SIZE = 1000;
const OPS = ["get", "has", "forEach", "for-of", "keys", "set-replace", "add-delete"];
// The read ops time a native Map walk / lookup of a few ns per entry: where
// setup() happens to place the table and the key strings moves them by
// ±5–15 % between builds with byte-identical code (docs/perf/leads/10-bench-harness.md).
// run.mjs randomises the heap layout per sample for them (child --pad).
const LAYOUT_SENSITIVE = new Set(["get", "has", "forEach", "for-of", "keys"]);

export default {
    name: "mutations/map-ops",
    unit: "µs/op",
    reps: 7,
    iterations: 2000,
    valueScale: 1000, // ms/op -> µs/op
    variants: [
        ...OPS.map((op) => ({ name: `${op}-str`, op, key: "string", layoutSensitive: LAYOUT_SENSITIVE.has(op) })),
        ...OPS.map((op) => ({ name: `${op}-num`, op, key: "number", layoutSensitive: LAYOUT_SENSITIVE.has(op) })),
    ],
    setup(lib, variant) {
        const { state, encoder, Player, key } = buildMapState(lib, variant.key, SIZE, SIZE);
        encoder.encode();
        encoder.discardChanges();
        const keys = [];
        for (let i = 0; i < SIZE; i++) keys.push(key(i));
        return { state, encoder, Player, key, keys, op: variant.op };
    },
    run(ctx, i) {
        const { state, encoder, keys, op } = ctx;
        const players = state.players;
        const scores = state.scores;
        let sum = 0;
        switch (op) {
            case "get": for (let k = 0; k < SIZE; k++) sum += players.get(keys[k]).position.x; break;
            case "has": for (let k = 0; k < SIZE; k++) if (players.has(keys[k])) sum++; break;
            case "forEach": players.forEach((p) => { sum += p.position.x; }); break;
            case "for-of": for (const [, p] of players) sum += p.position.x; break;
            case "keys": for (const k of players.keys()) if (k !== undefined) sum++; break;
            case "set-replace": {
                for (let k = 0; k < SIZE; k++) scores.set(keys[k], i + k);
                encoder.discardChanges();
                sum = scores.size;
                break;
            }
            case "add-delete": {
                for (let k = 0; k < 100; k++) players.set(ctx.key(SIZE + k), makeMapPlayer(ctx.Player, k));
                for (let k = 0; k < 100; k++) players.delete(ctx.key(SIZE + k));
                encoder.discardChanges();
                sum = players.size;
                break;
            }
        }
        return sum >= 0 ? undefined : -1; // sink guard, no bytes metric
    },
};
