/**
 * Shared routing helpers for streamable collections (`StreamSchema`,
 * `MapSchema.stream()`, etc.).
 *
 * Each streamable class carries exactly one lazy slot (`_stream`) that
 * holds the 6 per-view / broadcast bookkeeping structures. Keeping the
 * slot undefined until streaming actually activates means non-streaming
 * `MapSchema` / `SetSchema` instances pay zero Map/Set allocations. One
 * declared slot → hidden-class shape stays stable across streaming and
 * non-streaming instances, so V8's ICs on `$items` / `journal` / etc.
 * stay monomorphic.
 *
 * Lives alongside `changeTree/*.ts` — another directory of module-level
 * free functions that operate on ChangeTree instances.
 */
import { OPERATION } from "../encoding/spec.js";
import type { Root, Streamable } from "./Root.js";

/**
 * Thrown (from both the `FieldBuilder` chainable and the decorator's
 * `addField` auto-flag) when a user attempts to stream an ArraySchema.
 * Centralized so the two callsites emit the same diagnostic.
 */
export const ARRAY_STREAM_NOT_SUPPORTED =
    "ArraySchema does not support streaming — positional ops " +
    "(splice / unshift / reverse) shift subsequent indexes, so holding " +
    "ADDs back for a later tick under `maxPerTick` would desync the " +
    "decoder. Use `t.stream(X)` (stable monotonic positions) or " +
    "`t.map(X).stream()` (stable keys) instead.";

/**
 * Per-instance bookkeeping for a streamable collection. Lazily allocated
 * by `ensureStreamState` when the collection's ChangeTree picks up the
 * `isStreamCollection` flag (or when the user touches `maxPerTick`).
 */
export interface StreamableState {
    /** Per-view ADD backlog: wire-indexes not yet sent to that view. */
    pendingByView: Map<number, Set<number>>;
    /** Per-view SENT set — decides whether `remove()` emits a DELETE. */
    sentByView: Map<number, Set<number>>;
    /** Broadcast-mode ADD backlog (no active views). */
    broadcastPending: Set<number>;
    /** Broadcast-mode SENT set. */
    sentBroadcast: Set<number>;
    /** Broadcast-mode DELETE queue — flushes next shared tick. */
    broadcastDeletes: Set<number>;
    /** Max ADD ops emitted per tick per view (or per shared tick). */
    maxPerTick: number;
    /**
     * Priority callback seeded from the schema declaration. Receives the
     * client's StateView and the candidate element; higher return values
     * emit first. Broadcast `encode()` ignores this and drains FIFO.
     * Instance-level override: assign to `stream.priority`.
     */
    priority?: (view: any, element: any) => number;
}

export function createStreamableState(): StreamableState {
    return {
        pendingByView: new Map(),
        sentByView: new Map(),
        broadcastPending: new Set(),
        sentBroadcast: new Set(),
        broadcastDeletes: new Set(),
        maxPerTick: 32,
    };
}

/** Allocate `_stream` on first use (idempotent). Returns the state. */
export function ensureStreamState(s: Streamable): StreamableState {
    return (s._stream ??= createStreamableState());
}

/**
 * Route an ADD into the pending backlogs.
 * - No active views: push into broadcast pending (shared encode drains up
 *   to `maxPerTick` per tick).
 * - With views: push into per-view pending for every currently-bound view.
 */
export function streamRouteAdd(s: Streamable, root: Root, index: number): void {
    // Broadcast mode (no views registered): seed broadcast pending so
    // the shared `encode()` pass drains it up to `maxPerTick` per tick.
    // View mode: do nothing — users must call `view.add(element)` per
    // entity to subscribe it for that view. This matches the StateView
    // design philosophy: per-client visibility is imperative, not
    // declarative. An encode-time predicate would be O(views × entities)
    // each tick — the whole reason StateView exists is to push that
    // bookkeeping to game-loop cadence.
    if (root.activeViews.size === 0) {
        ensureStreamState(s).broadcastPending.add(index);
    }
}

/**
 * Route a REMOVE: silent-drop if never sent, force DELETE if already sent.
 * Returns `true` iff no wire op reached any channel (caller can skip
 * follow-on work like snapshotting the deleted value).
 */
export function streamRouteRemove(
    s: Streamable,
    root: Root,
    refId: number,
    index: number,
): boolean {
    // If `_stream` is still undefined, streaming never saw any add/remove —
    // nothing to unwind, and nothing was ever emitted.
    const st = s._stream;
    if (st === undefined) return true;

    let neverSent = false;

    // Broadcast side.
    if (st.broadcastPending.delete(index)) {
        neverSent = true;
    } else if (st.sentBroadcast.delete(index)) {
        st.broadcastDeletes.add(index);
    }

    // Per-view side.
    root.forEachActiveView((view) => {
        const pending = st.pendingByView.get(view.id);
        if (pending?.has(index)) {
            pending.delete(index);
            neverSent = true;
            return;
        }
        const sent = st.sentByView.get(view.id);
        if (sent?.has(index)) {
            sent.delete(index);
            let changes = view.changes.get(refId);
            if (changes === undefined) {
                changes = new Map();
                view.changes.set(refId, changes);
            }
            changes.set(index, OPERATION.DELETE);
        }
    });

    return neverSent;
}

/**
 * Queue DELETE ops for every already-sent entry on all channels and
 * reset pending. Caller is responsible for actually clearing its own
 * storage and releasing any element refs it owns.
 */
export function streamRouteClear(s: Streamable, root: Root, refId: number): void {
    const st = s._stream;
    if (st === undefined) return;

    // Broadcast: drop never-sent pending; force DELETE for sent entries.
    st.broadcastPending.clear();
    for (const index of st.sentBroadcast) st.broadcastDeletes.add(index);
    st.sentBroadcast.clear();

    // Per-view: clear pending; force DELETE for sent entries via
    // `view.changes` (drained first in encodeView).
    root.forEachActiveView((view) => {
        st.pendingByView.get(view.id)?.clear();

        const sent = st.sentByView.get(view.id);
        if (sent !== undefined && sent.size > 0) {
            let changes = view.changes.get(refId);
            if (changes === undefined) {
                changes = new Map();
                view.changes.set(refId, changes);
            }
            for (const index of sent) changes.set(index, OPERATION.DELETE);
            sent.clear();
        }
    });
}

/**
 * Push a single position into `_pendingByView[viewId]` — the building
 * block for `StateView.add(element)` when the element lives under a
 * streamable collection. Idempotent for already-pending positions.
 */
export function streamEnqueueForView(s: Streamable, viewId: number, index: number): void {
    const st = ensureStreamState(s);
    let pending = st.pendingByView.get(viewId);
    if (pending === undefined) {
        pending = new Set();
        st.pendingByView.set(viewId, pending);
    }
    pending.add(index);
}

/**
 * Unsubscribe a single position from a view. Returns true iff the
 * element had already been sent and a DELETE op was queued on
 * `view.changes`; false if it was only pending (silent drop) or not
 * present at all.
 */
export function streamDequeueForView(
    s: Streamable,
    viewId: number,
    refId: number,
    index: number,
    viewChanges: Map<number, Map<number, number>>,
): boolean {
    const st = s._stream;
    if (st === undefined) return false;
    const pending = st.pendingByView.get(viewId);
    if (pending?.has(index)) {
        pending.delete(index);
        return false;
    }
    const sent = st.sentByView.get(viewId);
    if (sent?.has(index)) {
        sent.delete(index);
        let changes = viewChanges.get(refId);
        if (changes === undefined) {
            changes = new Map();
            viewChanges.set(refId, changes);
        }
        changes.set(index, OPERATION.DELETE);
        return true;
    }
    return false;
}

/**
 * Drop all per-view state for a disposing/GC'd StateView. Keeps memory
 * bounded in long-running rooms with client churn.
 */
export function streamDropView(s: Streamable, viewId: number): void {
    const st = s._stream;
    if (st === undefined) return;
    st.pendingByView.delete(viewId);
    st.sentByView.delete(viewId);
}
