import * as assert from "assert";
import { KeyedRecorder } from "../src/encoder/KeyedRecorder";
import { OPERATION } from "../src/encoding/spec";

describe("KeyedRecorder", () => {
    const { ADD, REPLACE, DELETE, DELETE_AND_ADD } = OPERATION;

    const cases: Array<[string, OPERATION | undefined, OPERATION, OPERATION]> = [
        // [label, pending, incoming, expected]
        ["ADD over nothing", undefined, ADD, ADD],
        ["REPLACE over nothing", undefined, REPLACE, REPLACE],
        ["DELETE_AND_ADD over nothing", undefined, DELETE_AND_ADD, DELETE_AND_ADD],
        ["ADD over DELETE", DELETE, ADD, DELETE_AND_ADD],
        ["REPLACE over DELETE", DELETE, REPLACE, DELETE_AND_ADD],
        ["DELETE_AND_ADD over DELETE", DELETE, DELETE_AND_ADD, DELETE_AND_ADD],
        ["REPLACE over ADD (still unseen)", ADD, REPLACE, ADD],
        ["ADD over ADD", ADD, ADD, ADD],
        ["DELETE_AND_ADD over ADD (displaced ref must be released)", ADD, DELETE_AND_ADD, DELETE_AND_ADD],
        ["REPLACE over REPLACE", REPLACE, REPLACE, REPLACE],
        ["DELETE_AND_ADD over REPLACE", REPLACE, DELETE_AND_ADD, DELETE_AND_ADD],
        ["ADD over DELETE_AND_ADD", DELETE_AND_ADD, ADD, DELETE_AND_ADD],
    ];

    cases.forEach(([label, pending, incoming, expected]) => {
        it(label, () => {
            const rec = new KeyedRecorder();
            if (pending !== undefined) rec.add(3, pending); // first record on an index stores the op as is
            rec.add(3, incoming);
            assert.strictEqual(rec.opAt(3), expected);
        });
    });

    it("DELETE overwrites any pending op and remembers the value", () => {
        const rec = new KeyedRecorder<string>();
        rec.add(1, ADD);
        rec.delete(1, "one");
        assert.strictEqual(rec.opAt(1), DELETE);
        assert.strictEqual(rec.deleted!.get(1), "one");
        assert.strictEqual(rec.has(), true);
    });

    it("clear() drops pending ops and is reported first", () => {
        const rec = new KeyedRecorder<string>();
        rec.add(1, ADD);
        rec.delete(2, "two");
        rec.clear();
        assert.strictEqual(rec.cleared, true);
        assert.strictEqual(rec.count, 0);
        assert.deepStrictEqual(rec.indexes(), []);
        assert.strictEqual(rec.opAt(1), undefined);
        assert.strictEqual(rec.opAt(2), undefined);
        assert.strictEqual(rec.deleted!.size, 0);
        rec.add(3, ADD);
        const seen: number[] = [];
        rec.forEach((index) => seen.push(index));
        assert.deepStrictEqual(seen, [-OPERATION.CLEAR, 3]);
        assert.strictEqual(rec.isPureAdd(), false);
    });

    it("remember() keeps a value without recording an op (streaming removals)", () => {
        const rec = new KeyedRecorder<string>();
        rec.remember(5, "five");
        assert.strictEqual(rec.has(), false);
        assert.strictEqual(rec.deleted!.get(5), "five");
        rec.forget(5);
        assert.strictEqual(rec.deleted!.has(5), false);
    });

    it("isPureAdd() and reset()", () => {
        const rec = new KeyedRecorder();
        rec.add(1, ADD);
        rec.add(2, ADD);
        assert.strictEqual(rec.isPureAdd(), true);
        rec.add(2, DELETE_AND_ADD);
        assert.strictEqual(rec.isPureAdd(), false);
        rec.reset();
        assert.strictEqual(rec.has(), false);
        assert.strictEqual(rec.size(), 0);
    });

    it("emits in first-record order; merging never moves an index (REPLACE is op 0)", () => {
        const rec = new KeyedRecorder<string>();
        rec.add(7, REPLACE);
        rec.add(2, ADD);
        rec.delete(9, "nine");
        rec.add(7, REPLACE);        // REPLACE over REPLACE: stays where it was
        rec.add(2, REPLACE);        // REPLACE over ADD: still an ADD, still second
        rec.add(9, ADD);            // ADD over DELETE: DELETE_AND_ADD, still third
        assert.deepStrictEqual(rec.indexes(), [7, 2, 9]);
        const seen: [number, number][] = [];
        rec.forEach((index, op) => seen.push([index, op]));
        assert.deepStrictEqual(seen, [[7, REPLACE], [2, ADD], [9, DELETE_AND_ADD]]);
        assert.strictEqual(rec.opAt(7), REPLACE, "a pending REPLACE (0) is not 'no op'");
        assert.strictEqual(rec.opAt(8), undefined);
        assert.strictEqual(rec.size(), 3);
    });

    it("reset() forgets every op and the next tick starts clean", () => {
        const rec = new KeyedRecorder();
        for (let tick = 0; tick < 3; tick++) {
            for (let i = 0; i < 50; i++) rec.add(i * 3, tick === 0 ? ADD : REPLACE);
            assert.strictEqual(rec.count, 50);
            assert.strictEqual(rec.opAt(6), tick === 0 ? ADD : REPLACE);
            rec.reset();
            assert.strictEqual(rec.count, 0);
            assert.strictEqual(rec.opAt(6), undefined);
            assert.deepStrictEqual(rec.indexes(), []);
        }
    });

    it("handles indexes far apart and drops pages that went idle", () => {
        const rec = new KeyedRecorder();
        const pagesOf = () => (rec as any).pages as (Uint8Array | undefined)[] | undefined;
        rec.add(5, ADD);
        assert.strictEqual(pagesOf(), undefined, "no page directory while the collection stays below 4096 wire indexes");
        rec.reset();
        rec.add(1_000_000, ADD);                 // a new page is needed: the directory is created
        assert.strictEqual(rec.opAt(1_000_000), ADD);
        assert.strictEqual(pagesOf()!.filter((page) => page !== undefined).length, 1);
        rec.reset();
        rec.add(2_000_000, ADD);                 // another page: the idle one goes
        assert.strictEqual(pagesOf()![1_000_000 >>> 12], undefined, "idle page dropped");
        assert.strictEqual(pagesOf()!.filter((page) => page !== undefined).length, 1);
        assert.strictEqual(rec.opAt(1_000_000), undefined);
        rec.reset();
        rec.add(1_000_000, ADD);                 // the dropped page comes back when needed

        rec.add(3, REPLACE);                     // same tick, back in the first page: both stay
        rec.add(2_000_000, DELETE_AND_ADD);      // growth again, in the SAME tick: nothing pending is lost
        assert.deepStrictEqual(rec.indexes(), [1_000_000, 3, 2_000_000]);
        assert.strictEqual(rec.opAt(3), REPLACE);
        assert.strictEqual(rec.opAt(1_000_000), ADD);
        assert.strictEqual(rec.opAt(2_000_000), DELETE_AND_ADD);
    });

    it("clear() inside a tick restarts at index 0 without leaking the dropped ops", () => {
        const rec = new KeyedRecorder<string>();
        rec.add(0, ADD);
        rec.add(1, ADD);
        rec.clear();
        rec.add(0, ADD);
        assert.deepStrictEqual(rec.indexes(), [0]);
        assert.strictEqual(rec.opAt(1), undefined);
        const seen: number[] = [];
        rec.forEach((index) => seen.push(index));
        assert.deepStrictEqual(seen, [-OPERATION.CLEAR, 0], "CLEAR is reported first");
    });

    it("recycle() drops the free and quarantined indexes; reset() keeps them", () => {
        const rec = new KeyedRecorder<string>();
        rec.free = [3, 1];
        rec.quarantine = [2];
        rec.reset();
        assert.deepStrictEqual([rec.free, rec.quarantine], [[3, 1], [2]]);
        rec.recycle();
        assert.deepStrictEqual([rec.free, rec.quarantine], [undefined, undefined]);
    });
});
