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
            if (pending !== undefined) rec.ops.set(3, pending);
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
        assert.strictEqual(rec.ops.size, 0);
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
});
