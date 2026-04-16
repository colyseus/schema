/**
 * MapJournal — owns the change-tracking and wire-protocol identity for a MapSchema.
 *
 * Replaces three parallel structures that previously lived on MapSchema:
 *   - `$indexes: Map<number, K>`        →  `keyByIndex`
 *   - `_collectionIndexes: { [key]: number }` (+ counter)  →  `indexByKey` + `nextIndex`
 *   - `deletedItems: { [index]: V }`    →  `snapshots`
 *
 * The journal is the single source of truth for:
 *   - assigning wire-protocol indexes to keys (server side)
 *   - looking up keys from wire indexes (server + client)
 *   - holding snapshots of removed values (for view-filter visibility checks)
 *
 * The journal does NOT track per-index operation types or maintain enqueue
 * order — those remain on `ChangeTree` for now. A future iteration may pull
 * them in too, but this version is intentionally scoped to the data-model
 * cleanup so we can validate the abstraction before going deeper.
 */
export class MapJournal<K = any> {
    /** index → key (was MapSchema.$indexes). Used by encoder and decoder. */
    keyByIndex: Map<number, K> = new Map();

    /**
     * key → index (was MapSchema._collectionIndexes — forward direction).
     * Server-only. Plain object so MapSchema can expose it via a getter
     * for backwards-compatible `_collectionIndexes?.[key]` access from
     * ChangeTree.forEachChild and similar polymorphic call sites.
     */
    indexByKey: { [key: string]: number } = {};

    /** Monotonic counter for assigning new indexes. Server-only. */
    private nextIndex: number = 0;

    /**
     * Snapshot of values at the moment they were deleted.
     * Used by `MapSchema[$filter]` to check view visibility of a value
     * that's already been removed from `$items` but whose DELETE op is
     * still in the encode queue.
     */
    snapshots: Map<number, any> = new Map();

    // ──────────────────────────────────────────────────────────────────
    // Server-side: recording mutations
    // ──────────────────────────────────────────────────────────────────

    /** Get the index assigned to a key, or undefined if never assigned. */
    indexOf(key: K): number | undefined {
        const idx = this.indexByKey[key as unknown as string];
        return idx === undefined ? undefined : idx;
    }

    /** Assign and return a new wire index for an unseen key. */
    assign(key: K): number {
        const index = this.nextIndex++;
        this.indexByKey[key as unknown as string] = index;
        this.keyByIndex.set(index, key);
        return index;
    }

    /** Stash a value at the moment it's deleted (for filter visibility checks). */
    snapshot(index: number, value: any): void {
        this.snapshots.set(index, value);
    }

    /** Discard a snapshot — called when a deleted slot is being re-set. */
    forgetSnapshot(index: number): void {
        this.snapshots.delete(index);
    }

    /** Look up a snapshot. Returns undefined if no DELETE is pending for this index. */
    snapshotAt(index: number): any {
        return this.snapshots.get(index);
    }

    // ──────────────────────────────────────────────────────────────────
    // Client-side (decoder): index↔key sync from the wire
    // ──────────────────────────────────────────────────────────────────

    /** Decoder calls this when it sees an ADD/DELETE_AND_ADD on the wire. */
    setIndex(index: number, key: K): void {
        this.keyByIndex.set(index, key);
        // Forward direction maintained for symmetry, even though decoder
        // rarely needs it. Cheap insert; keeps invariants aligned.
        this.indexByKey[key as unknown as string] = index;
    }

    // ──────────────────────────────────────────────────────────────────
    // Lookups (both sides)
    // ──────────────────────────────────────────────────────────────────

    /** Reverse lookup: wire index → key. */
    keyOf(index: number): K | undefined {
        return this.keyByIndex.get(index);
    }

    // ──────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────

    /**
     * Called from MapSchema's $onEncodeEnd hook.
     * Cleans up index/key mappings for entries that were deleted in this tick.
     */
    cleanupAfterEncode(): void {
        for (const [index] of this.snapshots) {
            const key = this.keyByIndex.get(index);
            if (key !== undefined) {
                delete this.indexByKey[key as unknown as string];
                this.keyByIndex.delete(index);
            }
        }
        this.snapshots.clear();
    }

    /** Reset everything (called on .clear()). */
    reset(): void {
        this.indexByKey = {};
        this.keyByIndex.clear();
        this.snapshots.clear();
        this.nextIndex = 0;
    }
}
