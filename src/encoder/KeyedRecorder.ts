import { OPERATION } from "../encoding/spec.js";
import type { Root } from "./Root.js";

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
 * the pending op of index `i` is a byte in a page (`0` = none, else `op + 1` —
 * `REPLACE` is 0). Not a `Map`: one cleared every tick drops its table and
 * re-grows it with rehashing (measured: bench/v6-results.md § Keyed recorder).
 * A reset zeroes the touched bytes and keeps the pages.
 *
 * Page 0 (indexes `0 … 4095`) is a direct field, created on the first recorded
 * op and growing with the collection (32 bytes, doubling), so many small maps
 * do not pay 4 KB each. Further pages are fixed 4 KB and live in a directory
 * that exists only once a collection has passed 4096 wire indexes (most
 * recorders never allocate it). A directory page that went idle is dropped
 * whenever a new one is needed (page 0 is kept: at most 4 KB, and only on a
 * collection that large); a reused wire index re-creates its page.
 */
const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;
const FIRST_PAGE_MIN = 32;

export class KeyedRecorder<V = any> {
    /** Dirty wire indexes in first-record order; only `[0, count)` is meaningful (never truncated: no regrowth per tick). */
    order: number[] = [];
    count = 0;
    cleared = false;
    deleted?: Map<number, V>;

    /** MapSchema / SetSchema / CollectionSchema: wire indexes free for reuse (a LIFO stack); `undefined` until the first one is freed. */
    free?: number[];
    /** Freed indexes a `StateView` still holds an entry for, re-checked at the next end of tick (`freeIndex`). */
    quarantine?: number[];

    /** Ops of wire indexes `0 … PAGE_SIZE-1`; `undefined` until the first recorded op, then grows with the collection. */
    private page0: Uint8Array | undefined = undefined;
    /** Pages for indexes ≥ PAGE_SIZE (slot 0 unused), created on first use. */
    private pages: (Uint8Array | undefined)[] | undefined = undefined;
    /** `epoch` at which each directory page was last written: a page not written this epoch holds only zeros. */
    private pageEpoch: number[] | undefined = undefined;
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
        const page = this.pageOf(index);
        if (page === undefined) return undefined;
        const stored = page[index & PAGE_MASK]; // beyond a short first page: `undefined`
        return (stored === 0 || stored === undefined) ? undefined : stored - 1;
    }

    has(): boolean {
        return this.cleared || this.count > 0;
    }

    size(): number {
        return this.count + (this.cleared ? 1 : 0);
    }

    isPureAdd(): boolean {
        if (this.cleared) return false;
        const order = this.order;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            if (this.pageOf(index)![index & PAGE_MASK] !== OPERATION.ADD + 1) return false;
        }
        return true;
    }

    /** Dirty indexes in wire order (a copy — for tests and debugging; hot paths walk `order` / `count`). */
    indexes(): number[] {
        return this.order.slice(0, this.count);
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        if (this.cleared) cb(-OPERATION.CLEAR, OPERATION.CLEAR);
        const order = this.order;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            cb(index, this.pageOf(index)![index & PAGE_MASK] - 1);
        }
    }

    reset(): void {
        this.dropOps();
        this.deleted?.clear();
        this.cleared = false;
    }

    recycle(): void {
        this.reset();
        // a pooled instance starts over at index 0: give the directory back (page 0 is zeroed and small — kept)
        this.pages = undefined;
        this.pageEpoch = undefined;
        this.free = this.quarantine = undefined;
    }

    /** Zero the bytes this epoch touched (O(dirty), pages kept) and start a new epoch. */
    private dropOps(): void {
        const order = this.order;
        for (let k = 0, n = this.count; k < n; k++) {
            const index = order[k];
            this.pageOf(index)![index & PAGE_MASK] = 0;
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

    /** The page holding `index`, if it exists (a recorded index always has one). */
    private pageOf(index: number): Uint8Array | undefined {
        if (index < PAGE_SIZE) return this.page0;
        const pages = this.pages;
        return (pages !== undefined) ? pages[index >>> PAGE_BITS] : undefined;
    }

    private pageFor(index: number): Uint8Array {
        if (index < PAGE_SIZE) {
            const page = this.page0;
            return (page !== undefined && index < page.length) ? page : this.growFirstPage(index);
        }
        const p = index >>> PAGE_BITS;
        const pages = this.pages;
        if (pages !== undefined) {
            const page = pages[p];
            if (page !== undefined) {
                this.pageEpoch![p] = this.epoch;
                return page;
            }
        }
        return this.newPage(p);
    }

    /** Page 0 starts at 32 bytes and doubles up to PAGE_SIZE (pending bytes are carried over). */
    private growFirstPage(index: number): Uint8Array {
        const old = this.page0;
        let size = (old !== undefined) ? old.length : FIRST_PAGE_MIN;
        while (size <= index) size <<= 1;
        const page = new Uint8Array(size);
        if (old !== undefined) page.set(old);
        this.page0 = page;
        return page;
    }

    /** Out of line: a collection needs a new page once per 4096 wire indexes. */
    private newPage(p: number): Uint8Array {
        let pages = this.pages, pageEpoch = this.pageEpoch;
        if (pages === undefined || pageEpoch === undefined) {
            pages = this.pages = [undefined];
            pageEpoch = this.pageEpoch = [0];
        }
        const epoch = this.epoch;
        // A page not written this epoch holds only zeros (every reset zeroes
        // what it touched): drop it.
        for (let q = 1; q < pages.length; q++) {
            if (pages[q] !== undefined && pageEpoch[q] !== epoch) pages[q] = undefined;
        }
        while (pages.length <= p) { pages.push(undefined); pageEpoch.push(0); } // dense directory: no holes
        pageEpoch[p] = epoch;
        return pages[p] = new Uint8Array(PAGE_SIZE);
    }
}

/**
 * Wire-index recycling of the keyed collections that reuse indexes (Map, Set,
 * Collection; never a stream). Called at the end of a tick that shipped, for an
 * index whose entry was removed and not re-set: it goes on the free stack,
 * reused from the next tick on (never in the same one — a DELETE + ADD would
 * merge). An index a `StateView` still holds a `view.changes` entry for is
 * quarantined instead, until that view drains. See
 * docs/perf/leads/06-wire-index-recycling-design.md.
 */
export function freeIndex(rec: KeyedRecorder, root: Root, refId: number, index: number): void {
    const pending = root.pendingViewChanges();
    for (let v = 0; v < pending.length; v++) {
        if (pending[v].get(refId)?.has(index)) {
            (rec.quarantine ??= []).push(index);
            return;
        }
    }
    (rec.free ??= []).push(index);
}

/** Re-check the indexes `freeIndex` quarantined at an earlier end of tick. */
export function releaseQuarantine(rec: KeyedRecorder, root: Root, refId: number): void {
    const held = rec.quarantine;
    if (held === undefined) return;
    rec.quarantine = undefined;
    for (let k = 0; k < held.length; k++) freeIndex(rec, root, refId, held[k]);
}
