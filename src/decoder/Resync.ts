import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $proxyTarget, $refId, $refTypeFieldIndexes, $resyncPrune, $transientFieldIndexes } from "../types/symbols.js";
import type { Metadata } from "../Metadata.js";
import type { Decoder } from "./Decoder.js";
import type { DataChange } from "./DecodeOperation.js";

/**
 * Resync ("full-snapshot reconciliation") support for {@link Decoder.decodeResync}.
 *
 * A rejoin snapshot is authoritative for everything it contains — but the
 * plain decode path is additive: entries deleted (or hidden by a view)
 * while the client was off the wire survive as ghosts. This module owns the
 * generic reconciliation algorithm:
 *
 * - during the decode walk, the collection DecodeOperation functions report
 *   every entry the payload touches ({@link resyncRecordVisit}) and every
 *   collection that appears at all ({@link resyncMarkPresent});
 * - after the walk, {@link resyncSweep} removes whatever was never reported,
 *   through the same DELETE bookkeeping the regular decode path uses
 *   (DataChange DELETE → onRemove; removeRef → GC).
 *
 * Storage-specific pruning (journal upkeep, array compaction, stream
 * exemption) lives on each collection class as `[$resyncPrune]` — declared
 * on the `Collection` interface, so every collection kind must state its
 * own sweep semantics.
 *
 * All entry points are guarded by `decoder.resyncVisited !== null` at the
 * call sites — the normal decode path never pays for any of this.
 */

/**
 * Record that the current structure's entry at `identity` (map string key /
 * element index) appeared in the payload — even when its value is unchanged
 * (`allChanges` cannot serve as this record: its pushes are guarded by
 * `previousValue !== value`, so unchanged entries would look unvisited).
 *
 * Also releases a replaced occupant: full-sync emits plain ADD (never
 * DELETE_AND_ADD), so an entry whose instance changed while this client was
 * off the wire would otherwise leak its previous ref (no onRemove, never
 * GC'd). This release is correct ONLY under a full snapshot — a live patch's
 * plain ADD over a different instance can be a positional rewrite (array
 * shift/unshift) where the occupant *moved* and is still alive; a snapshot
 * re-adds moved instances elsewhere, so the refcounts balance.
 */
export function resyncTouchEntry(
    decoder: Decoder,
    ref: any,
    operation: OPERATION,
    identity: number | string,
    previousValue: any,
    value: any,
    allChanges: DataChange[] | null,
) {
    const visited = decoder.resyncVisited!;
    let set = visited.get(decoder.currentRefId);
    if (set === undefined) { visited.set(decoder.currentRefId, set = new Set()); }
    set.add(identity);

    if (previousValue !== undefined && operation === OPERATION.ADD && previousValue !== value) {
        const previousRefId = previousValue[$refId];
        if (previousRefId !== undefined) {
            decoder.root.removeRef(previousRefId);
            allChanges?.push({
                ref,
                refId: decoder.currentRefId,
                op: OPERATION.DELETE,
                dynamicIndex: identity,
                value: undefined,
                previousValue,
            });
        }
    }
}

/**
 * Mark a collection as present in the payload — even with zero entries.
 * The sweep only prunes collections reported here: absence means "not part
 * of full-sync" (@transient, view-invisible), where pruning would destroy
 * live data. Reflected clients have no @transient metadata, so payload
 * presence is the only reliable signal.
 */
export function resyncMarkPresent(decoder: Decoder, refId: number) {
    const visited = decoder.resyncVisited!;
    if (!visited.has(refId)) { visited.set(refId, new Set()); }
}

/**
 * Post-decode phase of {@link Decoder.decodeResync}: remove every collection
 * entry the snapshot did not visit.
 *
 * Walks the tree from the root — NOT `root.refs` — for three reasons:
 * `@transient` fields are never part of a snapshot and must be left alone;
 * entries of subtrees removed by the sweep itself are left to the GC's
 * transitive walk (sweeping them directly would double-decrement shared
 * children); and collections the snapshot never mentions (emptied
 * server-side) are still reachable and get pruned.
 */
export function resyncSweep(decoder: Decoder, allChanges: DataChange[] | null) {
    if (decoder.resyncDamaged) {
        console.warn(
            "@colyseus/schema: resync sweep skipped — parts of the payload could not be decoded. " +
            "Stale entries may persist until the next resync."
        );
        return;
    }
    sweepSchema(decoder, decoder.state as unknown as Schema, new Set(), allChanges);
}

function sweepSchema(decoder: Decoder, ref: Schema, seen: Set<number>, allChanges: DataChange[] | null) {
    const refId = (ref as any)[$refId];
    if (refId === undefined || seen.has(refId)) { return; }
    seen.add(refId);

    const metadata: Metadata = (ref.constructor as typeof Schema)[Symbol.metadata];
    const refIndexes = metadata?.[$refTypeFieldIndexes] as number[] | undefined;
    if (refIndexes === undefined) { return; }
    const transient = metadata[$transientFieldIndexes] as number[] | undefined;

    for (let i = 0; i < refIndexes.length; i++) {
        const fieldIndex = refIndexes[i];
        // @transient fields are never in a snapshot — leave them alone.
        if (transient !== undefined && transient.includes(fieldIndex)) { continue; }

        const field = metadata[fieldIndex];
        const value = (ref as any)[field.name];
        if (!value) { continue; }

        if (Schema.is(field.type)) {
            sweepSchema(decoder, value, seen, allChanges);
        } else {
            sweepCollection(decoder, value, seen, allChanges);
        }
    }
}

function sweepCollection(decoder: Decoder, coll: any, seen: Set<number>, allChanges: DataChange[] | null) {
    const tgt: any = coll[$proxyTarget] ?? coll;
    const refId = tgt[$refId];
    if (refId === undefined || seen.has(refId)) { return; }
    seen.add(refId);

    // `undefined` = the collection never appeared in the payload at all
    // (not even as its parent's field op) — it is not part of full-sync
    // (@transient, view-invisible) and must be left alone. An empty Set
    // means "present with zero entries" → prune everything.
    const visited = decoder.resyncVisited!.get(refId);
    if (visited === undefined) { return; }

    const $root = decoder.root;
    tgt[$resyncPrune](
        visited,
        (value: any, identity: number | string) => {
            allChanges?.push({
                ref: coll,
                refId,
                op: OPERATION.DELETE,
                dynamicIndex: identity,
                value: undefined,
                previousValue: value,
            });
            const childRefId = value?.[$refId];
            if (childRefId !== undefined) { $root.removeRef(childRefId); }
        },
        (value: any) => {
            // recurse so nested collections of retained entries sweep too
            if (Schema.isSchema(value)) { sweepSchema(decoder, value, seen, allChanges); }
        },
    );
}
