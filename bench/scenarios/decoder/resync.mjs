// Late-join reconciliation: decodeResync() of a full snapshot over an already
// bootstrapped 1000-entity decoder. `full` re-applies the identical snapshot
// (pure body-merge + sweep cost); `churn` alternates a 90 %-entity snapshot
// with the full one, so every other frame prunes 100 entities and the next
// re-adds them (refIds stay stable: the entities are removed and re-set on
// the encoder side only for the snapshot capture).
import { buildBloatState, codecOf, withCodecs } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/resync",
    unit: "ms/frame",
    iterations: 40,
    reps: 7,
    variants: withCodecs([
        { name: "full", churn: false },
        { name: "churn", churn: true },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const { state, encoder, State } = buildBloatState(lib, 1000, codec);
        const snapshotA = encoder.encodeAll().slice();
        encoder.discardChanges();

        let snapshotB = snapshotA;
        if (variant.churn) {
            const removed = [];
            for (let i = 0; i < 100; i++) { removed.push([`p${i}`, state.players.get(`p${i}`)]); state.players.delete(`p${i}`); }
            encoder.encode(); encoder.discardChanges();
            snapshotB = encoder.encodeAll().slice();
            for (const [key, p] of removed) state.players.set(key, p);
            encoder.encode(); encoder.discardChanges();
        }

        const decoder = new codec.Decoder(new State());
        decoder.decode(snapshotA);
        return { decoder, snapshots: [snapshotA, snapshotB] };
    },
    run(ctx, i) {
        const snapshot = ctx.snapshots[i % 2];
        ctx.decoder.decodeResync(snapshot);
        return snapshot.byteLength;
    },
    teardown(ctx) {
        // ends on snapshot A (i counts from warmup; both parities re-converge on A within two frames)
        ctx.decoder.decodeResync(ctx.snapshots[0]);
        if (ctx.decoder.state.players.size !== 1000) throw new Error(`resync left ${ctx.decoder.state.players.size} players`);
    },
};
