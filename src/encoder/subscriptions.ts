/**
 * Per-view collection subscriptions — `view.subscribe(collection)` opts
 * a view into ALL future content changes of a collection, not just a
 * one-shot snapshot. Covers every collection type:
 *
 * - `ArraySchema` / `MapSchema` / `SetSchema` / `CollectionSchema`: new
 *   children are force-shipped immediately via `view._addImmediate(child)`.
 *   Subsequent field mutations on those children emit via the normal
 *   view pass (the children are now visible).
 * - `StreamSchema` (or a `.stream()` map/set): new positions are
 *   enqueued into `_pendingByView` so the encoder's priority pass
 *   drains them respecting `maxPerTick`.
 *
 * The propagation hook is in `changeTree/treeAttachment.ts setParent`
 * — every new child attachment to a collection checks the parent tree's
 * `subscribedViews` bitmap and fans out to subscribed views.
 */
import type { ChangeTree, Ref } from "./ChangeTree.js";
import type { Root, Streamable } from "./Root.js";
import { streamEnqueueForView } from "./streaming.js";
import { $changes } from "../types/symbols.js";

/**
 * Walk the `subscribedViews` bitmap of `parentTree` and propagate a new
 * child attachment to every subscribed view. Streams route through the
 * priority/pending queue; all other collections force-ship immediately.
 */
export function propagateNewChildToSubscribers(
    parentTree: ChangeTree,
    childIndex: number,
    childRef: Ref,
    root: Root,
): void {
    const subs = parentTree.subscribedViews;
    if (subs === undefined) return;

    const isStream = parentTree.isStreamCollection;
    const streamable = isStream ? (parentTree.ref as unknown as Streamable) : undefined;
    const childTree = isStream ? undefined : childRef[$changes];

    // Walk set bits via clz32 — same pattern as the inline recorder
    // iteration elsewhere in the encoder.
    for (let slot = 0, n = subs.length; slot < n; slot++) {
        let bits = subs[slot];
        while (bits !== 0) {
            const bit = bits & -bits;
            bits ^= bit;
            const viewId = slot * 32 + (31 - Math.clz32(bit));
            const weakRef = root.activeViews.get(viewId);
            const view = weakRef?.deref();
            if (view === undefined) {
                // View was disposed / GC'd; clear the stale subscription bit.
                subs[slot] &= ~bit;
                continue;
            }
            if (isStream) {
                // Streams bypass the recorder — enqueue for the priority
                // pass to drain under `maxPerTick`.
                streamEnqueueForView(streamable!, viewId, childIndex);
            } else if (childTree !== undefined) {
                // Non-stream collections: just markVisible. The parent's
                // recorder already carries the ADD op (triggered by the
                // push/set/add that led to this setParent), and the
                // child's tree carries its construction-time dirty state
                // — the encoder's normal view pass picks both up on the
                // next encode, no view.changes seeding needed.
                view.markVisible(childTree);
            }
        }
    }
}
