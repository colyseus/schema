/**
 * Walk all currently-populated non-patchOnly indexes on a tree, emitting
 * each index once. Used by `ChangeTree.restage`, the full-sync walk and
 * `StateView.add` to derive full-sync output from the live structure.
 *
 * Patch-only fields (`@patchOnly`) are skipped — they're delivered only on
 * tick patches and not persisted to snapshots. Collections whose parent
 * field is @patchOnly inherit the skip (`tree.isPatchOnly`).
 *
 * `@deprecated()` fields are skipped too: the decorator swaps the field's
 * prototype accessor for a throwing getter, so `ref[name]` below would blow
 * up full sync for the whole state. Both skips ride one decoration-time
 * list (`liveIndexes` on the descriptor).
 */
import { KIND_ARRAY, KIND_MAP, KIND_SCHEMA } from "../../encoding/spec.js";
import type { ChangeTree } from "../ChangeTree.js";
import type { RefTable } from "../../RefTable.js";

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
    // `refTarget` is the raw instance (the un-proxied array for ArraySchema).
    const ref = tree.refTarget as any;
    const desc = tree.encDescriptor;

    if (desc.kind === KIND_SCHEMA) {
        // Schema: walk declared fields. `null` is treated as absent —
        // the setter records a DELETE when a field is set to null or
        // undefined, so it should not appear in full-sync output.
        // (@patchOnly skips matter to the resync sweep — see
        // decoder/Resync.ts: absent-from-payload means never pruned.)
        const live = desc.liveIndexes;
        const names = desc.names;
        for (let k = 0, len = live.length; k < len; k++) {
            const i = live[k];
            const value = ref[names[i]];
            if (value !== undefined && value !== null) cb(ctx, i);
        }
        return;
    }

    // Collection inheriting @patchOnly from parent field: skip entirely.
    // The resync sweep (decoder/Resync.ts) relies on this: a collection
    // absent from full-sync output is never pruned client-side.
    if (tree.isPatchOnly) return;

    if (desc.kind === KIND_ARRAY) {
        const els = tree.elements;
        for (let i = 0, len = els.length; i < len; i++) cb(ctx, i);

    } else if (desc.kind === KIND_MAP) {
        const $items: Map<any, any> = ref.$items;
        // one closure per map walked (not per entry); `RefTable.forEach` is a plain loop
        (ref.keyByIndex as RefTable<any>).forEach((key, index) => {
            if ($items.has(key)) cb(ctx, index);
        });

    } else {
        // SetSchema / CollectionSchema / StreamSchema (key === wire index)
        for (const index of (ref.$items as Map<number, any>).keys()) {
            cb(ctx, index);
        }
    }
}
