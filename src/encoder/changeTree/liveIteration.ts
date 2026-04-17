/**
 * Walk all currently-populated non-transient indexes on a tree, emitting
 * each index once. Used by Root.add (re-stage), Encoder.encodeAll, and
 * StateView.add to derive full-sync output from the live structure.
 *
 * Transient fields (`@transient`) are skipped — they're delivered only on
 * tick patches and not persisted to snapshots. Collections whose parent
 * field is @transient inherit the skip (`tree.isTransient`).
 */
import { $childType, $numFields, $transientFieldIndexes } from "../../types/symbols.js";
import type { ChangeTree } from "../ChangeTree.js";

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
    const ref = tree.ref as any;

    if (ref[$childType] !== undefined) {
        // Collection inheriting @transient from parent field: skip entirely.
        if (tree.isTransient) return;

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
        //
        // Read names from the per-class descriptor's parallel array —
        // saves the `metadata[i]` (per-field obj) + `.name` chain on
        // every iteration of the full-sync DFS.
        const metadata = tree.metadata;
        if (!metadata) return;
        const numFields = (metadata[$numFields] ?? -1) as number;
        const transientIndexes = metadata[$transientFieldIndexes];
        const names = tree.encDescriptor.names;
        for (let i = 0; i <= numFields; i++) {
            const name = names[i];
            if (name === undefined) continue;
            if (transientIndexes && transientIndexes.includes(i)) continue;
            const value = ref[name];
            if (value !== undefined && value !== null) cb(ctx, i);
        }
    }
}
