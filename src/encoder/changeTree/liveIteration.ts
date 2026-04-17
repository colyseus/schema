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

export function forEachLive(tree: ChangeTree, callback: (index: number) => void): void {
    const ref = tree.ref as any;

    if (ref[$childType] !== undefined) {
        // Collection inheriting @transient from parent field: skip entirely.
        if (tree.isTransient) return;

        // Collection types: dispatch by shape.
        if (Array.isArray(ref.items)) {
            // ArraySchema
            const items = ref.items as any[];
            for (let i = 0, len = items.length; i < len; i++) {
                if (items[i] !== undefined) callback(i);
            }
        } else if (ref.journal !== undefined) {
            // MapSchema
            for (const [index, key] of ref.journal.keyByIndex as Map<number, any>) {
                if (ref.$items.has(key)) callback(index);
            }
        } else if (ref.$items !== undefined) {
            // SetSchema / CollectionSchema (key === wire index)
            for (const index of (ref.$items as Map<number, any>).keys()) {
                callback(index);
            }
        }
    } else {
        // Schema: walk declared fields. `null` is treated as absent —
        // the setter records a DELETE when a field is set to null or
        // undefined, so it should not appear in full-sync output.
        const metadata = tree.metadata;
        if (!metadata) return;
        const numFields = (metadata[$numFields] ?? -1) as number;
        const transientIndexes = metadata[$transientFieldIndexes];
        for (let i = 0; i <= numFields; i++) {
            const field = metadata[i as any];
            if (field === undefined) continue;
            if (transientIndexes && transientIndexes.includes(i)) continue;
            const value = ref[field.name];
            if (value !== undefined && value !== null) callback(i);
        }
    }
}
