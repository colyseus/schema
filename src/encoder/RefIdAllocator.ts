/**
 * Allocates monotonically-increasing refIds with a reuse pool.
 *
 * `acquire()` pops from the free pool when available, otherwise bumps a
 * counter. `release()` queues a refId for reuse; the id doesn't become
 * acquirable until `flushReleases()` runs — the one-tick defer is what
 * lets the encoder guarantee a DELETE for the old instance reaches the
 * wire before the refId is handed to a new one.
 *
 * `reclaim()` handles "resurrection": a ref that was released but whose
 * JS instance is still alive can be re-added to the tree, in which case
 * the encoder must pull the refId back out of the pool before it's
 * handed to an unrelated instance.
 */
export class RefIdAllocator {
    protected nextUniqueId: number;

    private _free: number[] = [];
    private _pending: number[] = [];
    private _pooled: Set<number> = new Set();

    constructor(startRefId: number = 0) {
        this.nextUniqueId = startRefId;
    }

    acquire(): number {
        if (this._free.length > 0) {
            const id = this._free.pop()!;
            this._pooled.delete(id);
            return id;
        }
        return this.nextUniqueId++;
    }

    release(refId: number): void {
        this._pending.push(refId);
        this._pooled.add(refId);
    }

    isPooled(refId: number): boolean {
        return this._pooled.has(refId);
    }

    /**
     * Remove a refId from the pool. Called when a ref whose refId was
     * released is being resurrected. O(n) scan of the relevant array,
     * but resurrection is rare.
     */
    reclaim(refId: number): void {
        if (!this._pooled.delete(refId)) return;
        let i = this._free.indexOf(refId);
        if (i !== -1) { this._free.splice(i, 1); return; }
        i = this._pending.indexOf(refId);
        if (i !== -1) { this._pending.splice(i, 1); }
    }

    /**
     * Promote this tick's releases into the acquirable set. Called from
     * `Encoder.discardChanges()` — never mid-encode.
     */
    flushReleases(): void {
        const pending = this._pending;
        if (pending.length === 0) return;
        const free = this._free;
        for (let i = 0; i < pending.length; i++) free.push(pending[i]);
        pending.length = 0;
    }
}
