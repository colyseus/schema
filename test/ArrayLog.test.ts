import * as assert from "assert";
import { ArrayLog } from "../src/encoder/ArrayLog";
import { ARRAY_OP } from "../src/encoding/spec";

/** `[op, a, b]` triples of the log. */
function entries(log: ArrayLog) {
    const out: number[][] = [];
    for (let i = 0; i < log.ops.length; i += 3) out.push([log.ops[i], log.ops[i + 1], log.ops[i + 2]]);
    return out;
}

function weights(log: ArrayLog) {
    let sum = 0;
    for (let i = 0; i < log.ops.length; i += 3) sum += ArrayLog.weight(log.ops, i);
    return sum;
}

describe("ArrayLog", () => {
    it("PUSH extends a trailing PUSH", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2], 0);
        log.push([3], 2);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.PUSH, 3, 0]]);
        assert.deepStrictEqual(log.vals, [1, 2, 3]);
        assert.strictEqual(log.rev, 3);
    });

    it("removing an element pushed this tick shortens the PUSH (rev shrinks)", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2, 3], 0);
        log.remove(2, [3]); // pop
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.PUSH, 2, 0]]);
        assert.deepStrictEqual(log.vals, [1, 2]);
        assert.strictEqual(log.rev, 2);

        log.remove(0, [1]); // shift: still inside the PUSH range
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.PUSH, 1, 0]]);
        assert.deepStrictEqual(log.vals, [2]);
        assert.strictEqual(log.rev, 1);

        log.remove(0, [2]);
        assert.deepStrictEqual(entries(log), []);
        assert.strictEqual(log.rev, 0);
    });

    it("a removal after a mid-tick snapshot records REMOVE instead", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2, 3], 0);
        log.snapRev = log.rev; // a client received the array at rev 3
        log.remove(2, [3]);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.PUSH, 3, 0], [ARRAY_OP.REMOVE, 2, 1]]);
        assert.strictEqual(log.rev, 4);
    });

    it("three shift()s coalesce to REMOVE(0, 3)", () => {
        const log = new ArrayLog<string>();
        log.reset(); // nothing pending, elements predate the tick
        log.remove(0, ["a"]);
        log.remove(0, ["b"]);
        log.remove(0, ["c"]);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.REMOVE, 0, 3]]);
        assert.deepStrictEqual(log.vals, ["a", "b", "c"]);
        assert.strictEqual(log.rev, 3);
    });

    it("two pop()s coalesce to REMOVE(len - 2, 2)", () => {
        const log = new ArrayLog<string>();
        log.remove(4, ["e"]);
        log.remove(3, ["d"]);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.REMOVE, 3, 2]]);
        assert.strictEqual(log.rev, 2);
    });

    it("set() twice on the same index overwrites the value and keeps the original prev", () => {
        const log = new ArrayLog<number>();
        log.set(1, 10, 11);
        log.set(1, 11, 12);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.SET, 1, 0]]);
        assert.deepStrictEqual(log.vals, [10, 12]);
        assert.strictEqual(log.rev, 1);
    });

    it("set() twice after a snapshot records two SETs", () => {
        const log = new ArrayLog<number>();
        log.set(1, 10, 11);
        log.snapRev = log.rev;
        log.set(1, 11, 12);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.SET, 1, 0], [ARRAY_OP.SET, 1, 0]]);
        assert.strictEqual(log.rev, 2);
    });

    it("set() over an element pushed this tick folds into the PUSH", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2, 3], 5); // array had 5 elements before
        log.set(6, 2, 20);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.PUSH, 3, 5]]);
        assert.deepStrictEqual(log.vals, [1, 20, 3]);
        assert.strictEqual(log.rev, 3);
    });

    it("clear() drops the pending entries and bumps baseSeq", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2], 0);
        log.snapRev = log.rev; // keeps the SET below out of the PUSH
        log.set(0, 1, 7);
        log.clear();
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.CLEAR, 0, 0]]);
        assert.strictEqual(log.baseSeq, 3);
        assert.strictEqual(log.rev, 4);
    });

    it("restate() bumps the revision and drops the pending entries", () => {
        const log = new ArrayLog<number>();
        log.push([1, 2], 0);
        log.restate([1, 2]);
        assert.deepStrictEqual(entries(log), [[ARRAY_OP.RESTATE, 2, 3]]);
        assert.strictEqual(log.baseSeq, 2);
        assert.strictEqual(log.rev, 3);
        assert.strictEqual(log.isPureAdd(), false);
    });

    it("reset() empties the log and moves baseSeq / snapRev to the revision", () => {
        const log = new ArrayLog<number>();
        log.push([1], 0);
        log.reverse();
        log.reset();
        assert.strictEqual(log.has(), false);
        assert.strictEqual(log.baseSeq, 2);
        assert.strictEqual(log.snapRev, 2);
        assert.strictEqual(log.rev, 2);
    });

    it("isPureAdd() is true for a PUSH-only log", () => {
        const log = new ArrayLog<number>();
        assert.strictEqual(log.isPureAdd(), true);
        log.push([1], 0);
        assert.strictEqual(log.isPureAdd(), true);
        log.reverse();
        assert.strictEqual(log.isPureAdd(), false);
    });

    it("rev === baseSeq + Σ weights after random op sequences", () => {
        let seed = 1234;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let run = 0; run < 200; run++) {
            const log = new ArrayLog<number>();
            const arr: number[] = [];
            const steps = 1 + Math.floor(rand() * 30);
            for (let s = 0; s < steps; s++) {
                const r = rand();
                if (r < 0.35 || arr.length === 0) {
                    const n = 1 + Math.floor(rand() * 3);
                    const values = Array.from({ length: n }, () => Math.floor(rand() * 100));
                    log.push(values, arr.length);
                    arr.push(...values);
                } else if (r < 0.55) {
                    const i = Math.floor(rand() * arr.length);
                    log.remove(i, arr.splice(i, 1));
                } else if (r < 0.75) {
                    const i = Math.floor(rand() * arr.length);
                    const v = Math.floor(rand() * 100);
                    log.set(i, arr[i], v);
                    arr[i] = v;
                } else if (r < 0.85) {
                    log.reverse();
                    arr.reverse();
                } else if (r < 0.9) {
                    log.snapRev = log.rev; // a client joined mid-tick
                } else if (r < 0.95) {
                    log.clear();
                    arr.length = 0;
                } else {
                    const i = Math.floor(rand() * (arr.length + 1));
                    const values = [Math.floor(rand() * 100)];
                    log.insert(i, values);
                    arr.splice(i, 0, ...values);
                }
                assert.strictEqual(log.rev, log.baseSeq + weights(log), `run ${run} step ${s}`);
                let consumed = 0;
                for (let i = 0; i < log.ops.length; i += 3) consumed += ArrayLog.consumed(log.ops, i);
                assert.strictEqual(log.vals.length, consumed, `run ${run} step ${s}: vals consumed`);
            }
        }
    });
});
