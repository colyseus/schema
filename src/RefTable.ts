/**
 * Small-dense-integer → value table with the read surface of a `Map<number, V>`.
 *
 * Users: the decoder's `refs` (refId → ref: a `Map` hash probe per chunk and per
 * ref-valued slot was 22…27 % of a steady decode tick), the encoder's
 * `Root.changeTrees` / `Root.refCount` (as plain objects with integer keys the
 * store and the `delete` were 14 % of an attach / detach churn loop, and a
 * push-2000 / pop-2000 tick fell off a dictionary-mode cliff, ×100), and
 * `MapSchema.keyByIndex` (wire index → key). All three key spaces are handed out
 * in order and never recycled, so a lookup is an array load and a "delete" is a
 * store of `undefined`.
 *
 * Layout, from measurements (bench/v6-results.md, "Reference tables"):
 *
 * - **Page 0 is a growable packed array** (keys `0 … PAGE_SIZE-1`), held in a
 *   direct field: one dependent load, and as small as the content. Most tables
 *   never leave it — and those never allocate the page directory at all. A fixed
 *   first page cost every new Encoder / Decoder its allocation (handshake +11 %
 *   at 4096 entries), and serving it through the directory cost a cold table one
 *   more load (1000 small decoders in one process: +10 %).
 * - **Further pages are fixed-size**, `pages[key >>> PAGE_BITS][key & MASK]`.
 *   Keys are never recycled — a long-lived room keeps allocating them — so a
 *   page is dropped once its last entry is deleted: memory follows the LIVE
 *   entries, not the highest key (the directory costs one slot per PAGE_SIZE
 *   keys ever allocated).
 * - **The frontier (highest) page is kept while empty**: keys only grow, so it is
 *   the one page that will receive more entries. Dropping it made a push-100 /
 *   pop-100 tick re-allocate a page every tick (+136 %, GC ×5). It is released
 *   when the table grows past it.
 *
 * `undefined` marks an empty slot, so it cannot be stored as a value. Iteration
 * is in ascending key order.
 */
const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

export class RefTable<V> {
    /** Keys `0 … PAGE_SIZE-1`; growable (its length is the highest key seen in it, plus one). */
    private page0: (V | undefined)[] = [];
    /** Live entries in `page0`. */
    private live0 = 0;
    /** Page directory for keys ≥ PAGE_SIZE, created on first use. Slot 0 is unused (`page0` serves it). */
    private pages: ((V | undefined)[] | undefined)[] | undefined = undefined;
    /** Live entries per directory page (slot 0 unused). */
    private live: number[] | undefined = undefined;
    private count = 0;

    get size(): number { return this.count; }

    get(key: number): V | undefined {
        const page0 = this.page0;
        if (key < page0.length) { return page0[key]; } // in bounds: a plain packed load
        if (!(key >= PAGE_SIZE)) { return undefined; } // page 0 miss — and `undefined` / NaN / negative, which `>>>` would alias to slot 0
        const pages = this.pages;
        if (pages === undefined) { return undefined; }
        const page = pages[key >>> PAGE_BITS];
        return (page !== undefined) ? page[key & PAGE_MASK] : undefined;
    }

    has(key: number): boolean {
        return this.get(key) !== undefined;
    }

    set(key: number, value: V): this {
        if (!(key >= 0)) { throw new RangeError(`RefTable: invalid key ${key}`); }
        if (key < PAGE_SIZE) {
            const page0 = this.page0;
            if (key === page0.length) {
                // the common case — keys are handed out in order, so a new one appends
                page0.push(value);
                this.live0++;
                this.count++;
                return this;
            }
            while (page0.length <= key) { page0.push(undefined); } // stays packed: no holes, no sparse store
            if (page0[key] === undefined) { this.live0++; this.count++; }
            page0[key] = value;
            return this;
        }
        const p = key >>> PAGE_BITS;
        const i = key & PAGE_MASK;
        const page = this.pageAt(p);
        if (page[i] === undefined) { this.live![p]++; this.count++; }
        page[i] = value;
        return this;
    }

    delete(key: number): boolean {
        if (!(key >= 0)) { return false; } // `undefined >>> 12` is 0: never let a missing key delete slot 0
        if (key < PAGE_SIZE) {
            const page0 = this.page0;
            if (key >= page0.length || page0[key] === undefined) { return false; }
            page0[key] = undefined;
            this.count--;
            // last live entry: give the storage back, unless page 0 is still the frontier (the next keys land there)
            if (--this.live0 === 0 && this.pages !== undefined) { this.page0 = []; }
            return true;
        }
        const pages = this.pages;
        if (pages === undefined) { return false; }
        const p = key >>> PAGE_BITS;
        const page = pages[p];
        if (page === undefined) { return false; }
        const i = key & PAGE_MASK;
        if (page[i] === undefined) { return false; }
        page[i] = undefined;
        this.count--;
        if (--this.live![p] === 0 && p !== pages.length - 1) { pages[p] = undefined; } // not the frontier: release
        return true;
    }

    clear(): void {
        this.page0 = [];
        this.live0 = 0;
        this.pages = undefined;
        this.live = undefined;
        this.count = 0;
    }

    /** Plain loops, not the generator behind `entries()`: this is the walk hot paths use (a full-sync over a 10 000-entry map). */
    forEach(callback: (value: V, key: number, table: this) => void): void {
        const page0 = this.page0;
        for (let i = 0; i < page0.length; i++) {
            const value = page0[i];
            if (value !== undefined) { callback(value, i, this); }
        }
        const pages = this.pages;
        if (pages === undefined) { return; }
        for (let p = 1; p < pages.length; p++) {
            const page = pages[p];
            if (page === undefined) { continue; }
            for (let i = 0; i < PAGE_SIZE; i++) {
                const value = page[i];
                if (value !== undefined) { callback(value, (p << PAGE_BITS) | i, this); }
            }
        }
    }

    *entries(): IterableIterator<[number, V]> {
        const page0 = this.page0;
        for (let i = 0; i < page0.length; i++) {
            const value = page0[i];
            if (value !== undefined) { yield [i, value]; }
        }
        const pages = this.pages;
        if (pages === undefined) { return; }
        for (let p = 1; p < pages.length; p++) {
            const page = pages[p];
            if (page === undefined) { continue; }
            for (let i = 0; i < PAGE_SIZE; i++) {
                const value = page[i];
                if (value !== undefined) { yield [(p << PAGE_BITS) | i, value]; }
            }
        }
    }

    *keys(): IterableIterator<number> {
        for (const entry of this.entries()) { yield entry[0]; }
    }

    *values(): IterableIterator<V> {
        for (const entry of this.entries()) { yield entry[1]; }
    }

    [Symbol.iterator](): IterableIterator<[number, V]> {
        return this.entries();
    }

    /** Fixed-size page `p ≥ 1`, created on first use (and with it, the directory). */
    private pageAt(p: number): (V | undefined)[] {
        let pages = this.pages;
        if (pages === undefined) {
            // leaving page 0 for the first time: it stops being the frontier
            pages = this.pages = [undefined];
            this.live = [0];
            if (this.live0 === 0) { this.page0 = []; }
        }
        let page = pages[p];
        if (page === undefined) {
            if (p >= pages.length) {
                // growing past the old frontier: it was kept while empty (see `delete`), release it now
                const last = pages.length - 1;
                if (last >= 1 && this.live![last] === 0) { pages[last] = undefined; }
                while (pages.length <= p) { pages.push(undefined); this.live!.push(0); } // dense directory: no holes
            }
            page = pages[p] = new Array<V | undefined>(PAGE_SIZE).fill(undefined);
        }
        return page;
    }
}
