import { OPERATION } from "../encoding/spec.js";

/**
 * KeyedRecorder — the change recorder of the wire-index-keyed collections
 * (`MapSchema`, `SetSchema`, `StreamSchema`).
 *
 * Entries are addressed by a stable wire index, so a tick's mutations merge
 * per index (last state wins) and first-record order is the wire order.
 * `CLEAR` is absorbing: it drops every pending op and is emitted first.
 *
 * Removed values are remembered in `deleted` until the end of the tick, so
 * the emitter can (a) resolve the visibility of a removed ref for a
 * `StateView` and (b) never needs to look a removed entry up in the
 * collection's storage.
 *
 * Storage: `order[0 … count)` lists the dirty indexes in first-record order;
 * the pending op of index `i` is a byte in a lazily allocated page
 * (`pages[i >>> 12][i & 4095]`, `0` = none, else `op + 1` — `REPLACE` is 0).
 * It replaced a `Map<index, op>` that was cleared every tick: a cleared Map
 * drops its table and re-grows it with rehashing, which made `ops.set` the
 * hottest line of a REPLACE-heavy tick (22.9 %; 31 → 7 ns per recorded op at
 * 1000 dirty entries, 67 → 28 ns at 10). A reset zeroes the touched bytes and
 * keeps the pages; a page costs 4 KB, and since wire indexes are never
 * recycled, pages that went idle are dropped whenever a new one is needed.
 */
const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

export class KeyedRecorder<V = any> {
    /** Dirty wire indexes in first-record order; only `[0, count)` is meaningful (never truncated: no regrowth per tick). */
    order: number[] = [];
    count = 0;
    cleared = false;
    deleted?: Map<number, V>;

    private pages: (Uint8Array | undefined)[] = [];
    /** `epoch` at which each page was last written: a page not written this epoch holds only zeros. */
    private pageEpoch: number[] = [];
    private epoch = 1;

    /**
     * Merge table (incoming over pending):
     *   ADD / REPLACE / DELETE_AND_ADD over DELETE → DELETE_AND_ADD
     *   DELETE_AND_ADD over anything            → DELETE_AND_ADD
     *   REPLACE over ADD                        → ADD (still unseen)
     *   otherwise                               → keep the pending op
     */
    add(index: number, op: OPERATION): void {
        const page = this.pageFor(index);
        const slot = index & PAGE_MASK;
        const stored = page[slot];
        if (stored === 0) {
            page[slot] = op + 1;
            this.append(index);
            return;
        }
        const prev: OPERATION = stored - 1;
        let next: OPERATION;
        if (prev === OPERATION.DELETE) next = OPERATION.DELETE_AND_ADD;
        else if (op === OPERATION.DELETE_AND_ADD) next = OPERATION.DELETE_AND_ADD;
        else if (prev === OPERATION.ADD && op === OPERATION.REPLACE) next = OPERATION.ADD;
        else next = prev;
        if (next !== prev) page[slot] = next + 1;
    }

    /** Record a DELETE and remember the removed value. */
    delete(index: number, prev: V): void {
        const page = this.pageFor(index);
        const slot = index & PAGE_MASK;
        if (page[slot] === 0) this.append(index);
        page[slot] = OPERATION.DELETE + 1;
        this.remember(index, prev);
    }

    /** Remember a removed value without recording an op (streaming paths route their own DELETEs). */
    remember(index: number, prev: V): void {
        (this.deleted ??= new Map()).set(index, prev);
    }

    /** A re-set of a slot removed earlier this tick no longer needs its snapshot. */
    forget(index: number): void {
        this.deleted?.delete(index);
    }

    clear(): void {
        this.dropOps();
        this.deleted?.clear();
        this.cleared = true;
    }

    opAt(index: number): OPERATION | undefined {
        const page = this.pages[index >>> PAGE_BITS];
        if (page === undefined) return undefined;
        const stored = page[index & PAGE_MASK];
        return (stored === 0) ? undefined : stored - 1;
    }

    has(): boolean {
        return this.cleared || this.count > 0;
    }

    size(): number {
        return this.count + (this.cleared ? 1 : 0);
    }

    isPureAdd(): boolean {
        if (this.cleared) return false;
        const order = this.order, pages = this.pages;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            if (pages[index >>> PAGE_BITS]![index & PAGE_MASK] !== OPERATION.ADD + 1) return false;
        }
        return true;
    }

    /** Dirty indexes in wire order (a copy — for tests and debugging; hot paths walk `order` / `count`). */
    indexes(): number[] {
        return this.order.slice(0, this.count);
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        if (this.cleared) cb(-OPERATION.CLEAR, OPERATION.CLEAR);
        const order = this.order, pages = this.pages;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            cb(index, pages[index >>> PAGE_BITS]![index & PAGE_MASK] - 1);
        }
    }

    reset(): void {
        this.dropOps();
        this.deleted?.clear();
        this.cleared = false;
    }

    recycle(): void {
        this.reset();
        // a pooled instance starts over at index 0: give the pages back
        this.pages = [];
        this.pageEpoch = [];
    }

    /** Zero the bytes this epoch touched (O(dirty), pages kept) and start a new epoch. */
    private dropOps(): void {
        const order = this.order, pages = this.pages;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            pages[index >>> PAGE_BITS]![index & PAGE_MASK] = 0;
        }
        this.count = 0;
        this.epoch++;
    }

    private append(index: number): void {
        const n = this.count++;
        const order = this.order;
        if (n < order.length) order[n] = index;
        else order.push(index);
    }

    private pageFor(index: number): Uint8Array {
        const p = index >>> PAGE_BITS;
        const page = this.pages[p];
        if (page !== undefined) {
            this.pageEpoch[p] = this.epoch;
            return page;
        }
        return this.newPage(p);
    }

    /** Out of line: a collection needs a new page once per 4096 wire indexes. */
    private newPage(p: number): Uint8Array {
        const pages = this.pages, pageEpoch = this.pageEpoch, epoch = this.epoch;
        // Wire indexes only grow, so old pages go idle for good. One not written
        // this epoch holds only zeros (every reset zeroes what it touched): drop it.
        for (let q = 0; q < pages.length; q++) {
            if (pages[q] !== undefined && pageEpoch[q] !== epoch) pages[q] = undefined;
        }
        while (pages.length <= p) { pages.push(undefined); pageEpoch.push(0); } // dense directory: no holes
        pageEpoch[p] = epoch;
        return pages[p] = new Uint8Array(PAGE_SIZE);
    }
}
