import * as assert from "assert";
import { RefTable } from "../src";

describe("RefTable", () => {
    const PAGE = 4096;
    const pagesOf = (table: RefTable<any>): any[] | undefined => (table as any).pages; // directory (slot 0 unused), lazy
    const page0Of = (table: RefTable<any>): any[] => (table as any).page0;

    it("behaves like a Map<number, V> for get / has / set / delete / size", () => {
        const table = new RefTable<string>();
        assert.strictEqual(table.size, 0);
        assert.strictEqual(table.get(0), undefined);
        assert.strictEqual(table.has(5000), false);
        assert.strictEqual(table.delete(5000), false);

        assert.strictEqual(table.set(0, "root"), table);
        table.set(7, "seven").set(5000, "far");
        assert.strictEqual(table.size, 3);
        assert.strictEqual(table.get(7), "seven");
        assert.strictEqual(table.get(5000), "far");
        assert.ok(table.has(0));

        table.set(7, "SEVEN"); // overwrite: size unchanged
        assert.strictEqual(table.size, 3);
        assert.strictEqual(table.get(7), "SEVEN");

        assert.strictEqual(table.delete(7), true);
        assert.strictEqual(table.delete(7), false);
        assert.strictEqual(table.size, 2);
        assert.strictEqual(table.get(7), undefined);

        table.clear();
        assert.strictEqual(table.size, 0);
        assert.strictEqual(table.get(0), undefined);
    });

    it("never aliases a missing / invalid refId to slot 0", () => {
        const table = new RefTable<string>();
        table.set(0, "root");
        for (const bad of [undefined, NaN, -1, null] as any[]) {
            if (bad !== null) assert.strictEqual(table.get(bad), undefined, `get(${bad})`);
            if (bad !== null) assert.strictEqual(table.delete(bad), false, `delete(${bad})`);
        }
        assert.strictEqual(table.get(0), "root", "slot 0 survived");
        assert.strictEqual(table.size, 1);
        assert.throws(() => table.set(undefined as any, "x"), RangeError);
        assert.throws(() => table.set(-1, "x"), RangeError);
    });

    it("iterates in ascending refId order", () => {
        const table = new RefTable<string>();
        for (const id of [3000, 2, 1500, 0, 1023, 1024]) table.set(id, `v${id}`);
        table.delete(1500);

        const expected = [0, 2, 1023, 1024, 3000];
        assert.deepStrictEqual(Array.from(table.keys()), expected);
        assert.deepStrictEqual(Array.from(table.values()), expected.map((id) => `v${id}`));
        assert.deepStrictEqual(Array.from(table), expected.map((id) => [id, `v${id}`]));

        const seen: number[] = [];
        table.forEach((value, refId) => { assert.strictEqual(value, `v${refId}`); seen.push(refId); });
        assert.deepStrictEqual(seen, expected);
    });

    it("drops a page once its last entry is deleted", () => {
        const table = new RefTable<number>();
        for (let id = 0; id < 3 * PAGE; id++) table.set(id, id);
        assert.strictEqual(pagesOf(table)!.filter((p) => p !== undefined).length, 2, "two fixed pages behind page 0");
        assert.strictEqual(page0Of(table).length, PAGE);

        for (let id = 0; id < PAGE; id++) table.delete(id); // first page only
        assert.strictEqual(page0Of(table).length, 0, "the (growable) first page gives its storage back");
        assert.notStrictEqual(pagesOf(table)![1], undefined);
        assert.strictEqual(table.size, 2 * PAGE);
        assert.strictEqual(table.get(10), undefined);
        assert.strictEqual(table.get(PAGE + 10), PAGE + 10);

        for (let id = PAGE; id < 2 * PAGE; id++) table.delete(id); // a middle page
        assert.strictEqual(pagesOf(table)![1], undefined, "an emptied fixed page is released");
        assert.strictEqual(table.size, PAGE);
        assert.strictEqual(table.get(PAGE + 10), undefined);
        assert.deepStrictEqual(Array.from(table.keys()).slice(0, 2), [2 * PAGE, 2 * PAGE + 1]);

        table.set(5, 5); // a released first page stays addressable
        assert.strictEqual(table.get(5), 5);
        assert.strictEqual(table.get(4), undefined);
    });

    it("grows the first page with the state instead of pre-allocating it", () => {
        const table = new RefTable<number>();
        assert.strictEqual(page0Of(table).length, 0);
        for (let id = 0; id < 12; id++) table.set(id, id);
        assert.strictEqual(page0Of(table).length, 12);
        assert.strictEqual(pagesOf(table), undefined, "a table that stays in page 0 never allocates the directory");
        table.set(300, 300); // a gap is filled, never left as holes
        assert.strictEqual(page0Of(table).length, 301);
        assert.strictEqual(table.get(299), undefined);
        assert.strictEqual(table.size, 13);
    });

    it("keeps the emptied frontier page until the table grows past it", () => {
        const table = new RefTable<number>();
        // push-100 / pop-100 per tick on monotonic refIds, all inside one fixed (frontier) page
        let next = PAGE;
        let frontier: any;
        for (let tick = 0; tick < 5; tick++) {
            const first = next;
            for (let k = 0; k < 100; k++) table.set(next++, 1);
            frontier ??= pagesOf(table)![1];
            for (let id = first; id < next; id++) table.delete(id);
            assert.strictEqual(table.size, 0);
            assert.strictEqual(pagesOf(table)![1], frontier, "the frontier page is reused, not re-allocated every tick");
        }
        // growing into the next page releases the old (empty) frontier
        table.set(2 * PAGE + 1, 1);
        assert.strictEqual(pagesOf(table)![1], undefined);
        assert.strictEqual(table.get(2 * PAGE + 1), 1);

        // same rule for page 0 while it is the frontier
        const small = new RefTable<number>();
        let id = 0, first0: any;
        for (let tick = 0; tick < 5; tick++) {
            const from = id;
            for (let k = 0; k < 100; k++) small.set(id++, 1);
            first0 ??= page0Of(small);
            for (let d = from; d < id; d++) small.delete(d);
            assert.strictEqual(page0Of(small), first0, "page 0 is kept while it is the frontier");
        }
        small.set(PAGE + 5, 1);
        assert.strictEqual(page0Of(small).length, 0, "and released once the table grows past it");
    });
});
