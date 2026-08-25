/**
 * Walk all currently-populated non-patchOnly indexes on a tree, emitting
 * each index once. Used by Root.add (re-stage), Encoder.encodeAll, and
 * StateView.add to derive full-sync output from the live structure.
 *
 * Patch-only fields (`@patchOnly`) are skipped — they're delivered only on
 * tick patches and not persisted to snapshots. Collections whose parent
 * field is @patchOnly inherit the skip (`tree.isPatchOnly`).
 *
 * `@deprecated()` fields are skipped too: the decorator swaps the field's
 * prototype accessor for a throwing getter, so `ref[name]` below would blow
 * up full sync for the whole state. Both skips ride one decoration-time
 * list (`$fullSyncSkipIndexes`) so the walk pays a single metadata lookup.
 */
import { OPERATION } from "../../encoding/spec.js";
import { $childType, $numFields, $fullSyncSkipIndexes } from "../../types/symbols.js";
import type { ChangeTree } from "../ChangeTree.js";

/**
 * Re-stage one live index as a fresh ADD on its channel. Shared by
 * `Root.add` (refCount-0 / NEEDS_RESTAGE re-adds) and
 * `inheritedFlags.refreshFilterState` (filtered→public flip) via
 * `forEachLiveWithCtx(tree, restageLiveCb)` — one home for the
 * unreliable-routing rule.
 */
export const restageLiveCb = (tree: ChangeTree, fieldIndex: number): void => {
    if (tree.isFieldUnreliable(fieldIndex)) {
        tree.ensureUnreliableRecorder().record(fieldIndex, OPERATION.ADD);
    } else {
        tree.record(fieldIndex, OPERATION.ADD);
    }
};

// Adapter that lets `forEachLive(cb)` delegate to `forEachLiveWithCtx(cb, _invokeNoCtx)` —
// keeps the no-ctx path closure-free and shares one walker implementation.
const _invokeNoCtx = (cb: (index: number) => void, index: number) => cb(index);

export function forEachLive(tree: ChangeTree, callback: (index: number) => void): void {
    forEachLiveWithCtx(tree, callback, _invokeNoCtx);
}

export function forEachLiveWithCtx<C>(
    tree: ChangeTree,
    ctx: C,
    cb: (ctx: C, index: number) => void,
): void {
    // `refTarget` skips the ArraySchema Proxy on every `.items` / `.$items`
    // / `[$childType]` read below. Same reference as `ref` for non-proxied
    // types. See `ChangeTree.refTarget` doc.
    const ref = tree.refTarget as any;

    if (ref[$childType] !== undefined) {
        // Collection inheriting @patchOnly from parent field: skip entirely.
        // The resync sweep (decoder/Resync.ts) relies on this: a collection
        // absent from full-sync output is never pruned client-side.
        if (tree.isPatchOnly) return;

        // Collection types: dispatch by shape.
        if (Array.isArray(ref.items)) {
            // ArraySchema
            const items = ref.items as any[];
            for (let i = 0, len = items.length; i < len; i++) {
                if (items[i] !== undefined) cb(ctx, i);
            }
        } else if (ref.journal !== undefined) {
            // MapSchema
            for (const [index, key] of ref.journal.keyByIndex as Map<number, any>) {
                if (ref.$items.has(key)) cb(ctx, index);
            }
        } else if (ref.$items !== undefined) {
            // SetSchema / CollectionSchema (key === wire index)
            for (const index of (ref.$items as Map<number, any>).keys()) {
                cb(ctx, index);
            }
        }
    } else {
        // Schema: walk declared fields. `null` is treated as absent —
        // the setter records a DELETE when a field is set to null or
        // undefined, so it should not appear in full-sync output.
        // (@patchOnly skips below matter to the resync sweep — see
        // decoder/Resync.ts: absent-from-payload means never pruned.)
        //
        // Read names from the per-class descriptor's parallel array —
        // saves the `metadata[i]` (per-field obj) + `.name` chain on
        // every iteration of the full-sync DFS.
        const metadata = tree.metadata;
        if (!metadata) return;
        const numFields = (metadata[$numFields] ?? -1) as number;
        const skipIndexes = metadata[$fullSyncSkipIndexes] as number[] | undefined;
        const names = tree.encDescriptor.names;
        for (let i = 0; i <= numFields; i++) {
            const name = names[i];
            if (name === undefined) continue;
            if (skipIndexes && skipIndexes.includes(i)) continue;
            const value = ref[name];
            if (value !== undefined && value !== null) cb(ctx, i);
        }
    }
}
