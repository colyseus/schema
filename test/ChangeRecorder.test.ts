import * as assert from "assert";
import { OPERATION } from "../src/encoding/spec";
import { SchemaChangeRecorder, CollectionChangeRecorder } from "../src/encoder/ChangeRecorder";

describe("ChangeRecorder", () => {

    describe("SchemaChangeRecorder", () => {
        it("records a single change in low mask", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD);

            assert.strictEqual(r.has(), true);
            assert.strictEqual(r.size(), 1);
            assert.strictEqual(r.operationAt(3), OPERATION.ADD);
        });

        it("records a change at field 32 (boundary into high mask)", () => {
            const r = new SchemaChangeRecorder(40);
            r.record(32, OPERATION.ADD);
            assert.strictEqual(r.has(), true);
            assert.strictEqual(r.size(), 1);

            const seen: number[] = [];
            r.forEach((idx) => seen.push(idx));
            assert.deepStrictEqual(seen, [32]);
        });

        it("records multiple changes spanning low and high masks", () => {
            const r = new SchemaChangeRecorder(64);
            r.record(0, OPERATION.ADD);
            r.record(31, OPERATION.ADD);
            r.record(32, OPERATION.ADD);
            r.record(63, OPERATION.ADD);

            assert.strictEqual(r.size(), 4);

            const seen: number[] = [];
            r.forEach((idx) => seen.push(idx));
            assert.deepStrictEqual(seen.sort((a, b) => a - b), [0, 31, 32, 63]);
        });

        it("merges DELETE+ADD into DELETE_AND_ADD", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.DELETE);
            r.record(2, OPERATION.ADD);
            assert.strictEqual(r.operationAt(2), OPERATION.DELETE_AND_ADD);
        });

        it("recordDelete records DELETE in the dirty bucket", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD);
            r.recordDelete(3, OPERATION.DELETE);
            assert.strictEqual(r.has(), true);
            assert.strictEqual(r.operationAt(3), OPERATION.DELETE);
        });

        it("first ADD wins; subsequent ADD does not change op", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.ADD);
            r.record(2, OPERATION.ADD);
            assert.strictEqual(r.operationAt(2), OPERATION.ADD);
        });

        it("setOperationAt overrides", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.ADD);
            r.setOperationAt(2, OPERATION.DELETE);
            assert.strictEqual(r.operationAt(2), OPERATION.DELETE);
        });

        it("reset() clears the dirty bucket", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD);
            r.reset();
            assert.strictEqual(r.has(), false);
        });

        it("forEach iterates in low-then-high order", () => {
            const r = new SchemaChangeRecorder(64);
            r.record(45, OPERATION.ADD);
            r.record(2, OPERATION.ADD);
            r.record(33, OPERATION.ADD);
            r.record(7, OPERATION.ADD);

            const seen: number[] = [];
            r.forEach((idx) => seen.push(idx));
            // low bits ascending, then high bits ascending
            assert.deepStrictEqual(seen, [2, 7, 33, 45]);
        });

        it("recordPure throws (Schema doesn't use pure ops)", () => {
            const r = new SchemaChangeRecorder(8);
            assert.throws(() => r.recordPure(OPERATION.CLEAR));
        });

        it("operationAt returns undefined for unrecorded indexes", () => {
            const r = new SchemaChangeRecorder(8);
            assert.strictEqual(r.operationAt(5), undefined);
        });

        it("size is precise via popcount", () => {
            const r = new SchemaChangeRecorder(64);
            for (let i = 0; i < 50; i++) r.record(i, OPERATION.ADD);
            assert.strictEqual(r.size(), 50);
        });
    });

    describe("CollectionChangeRecorder", () => {
        it("records sparse indexes (e.g., 0, 7, 1024)", () => {
            const r = new CollectionChangeRecorder();
            r.record(0, OPERATION.ADD);
            r.record(7, OPERATION.ADD);
            r.record(1024, OPERATION.ADD);

            assert.strictEqual(r.size(), 3);

            const seen: number[] = [];
            r.forEach((idx) => seen.push(idx));
            // Map iteration order is insertion order
            assert.deepStrictEqual(seen, [0, 7, 1024]);
        });

        it("merges DELETE+ADD into DELETE_AND_ADD", () => {
            const r = new CollectionChangeRecorder();
            r.record(5, OPERATION.DELETE);
            r.record(5, OPERATION.ADD);
            assert.strictEqual(r.operationAt(5), OPERATION.DELETE_AND_ADD);
        });

        it("recordDelete records DELETE in the dirty bucket", () => {
            const r = new CollectionChangeRecorder();
            r.record(7, OPERATION.ADD);
            r.recordDelete(7, OPERATION.DELETE);
            assert.strictEqual(r.has(), true);
            assert.strictEqual(r.operationAt(7), OPERATION.DELETE);
        });

        it("recordPure stores CLEAR/REVERSE interleaved with indexed ops", () => {
            const r = new CollectionChangeRecorder();
            r.record(0, OPERATION.ADD);
            r.recordPure(OPERATION.CLEAR);

            assert.strictEqual(r.size(), 2);

            const seen: Array<[number, number]> = [];
            r.forEach((idx, op) => seen.push([idx, op]));

            // Indexed first (Map order), then pure ops as negative values
            assert.deepStrictEqual(seen, [
                [0, OPERATION.ADD],
                [-OPERATION.CLEAR, OPERATION.CLEAR],
            ]);
        });

        it("reset clears the dirty bucket", () => {
            const r = new CollectionChangeRecorder();
            r.record(1, OPERATION.ADD);
            r.record(2, OPERATION.ADD);

            r.reset();
            assert.strictEqual(r.has(), false);
        });

        it("operationAt returns stored op", () => {
            const r = new CollectionChangeRecorder();
            r.record(3, OPERATION.ADD);
            assert.strictEqual(r.operationAt(3), OPERATION.ADD);

            r.setOperationAt(3, OPERATION.DELETE);
            assert.strictEqual(r.operationAt(3), OPERATION.DELETE);
        });
    });

    describe("conformance: both implementations satisfy the same contract", () => {
        const variants: Array<[string, () => SchemaChangeRecorder | CollectionChangeRecorder]> = [
            ["SchemaChangeRecorder", () => new SchemaChangeRecorder(64)],
            ["CollectionChangeRecorder", () => new CollectionChangeRecorder()],
        ];

        for (const [name, factory] of variants) {
            it(`${name}: empty state`, () => {
                const r = factory();
                assert.strictEqual(r.has(), false);
                assert.strictEqual(r.size(), 0);
                let count = 0;
                r.forEach(() => count++);
                assert.strictEqual(count, 0);
            });

            it(`${name}: record + iterate cycle`, () => {
                const r = factory();
                r.record(5, OPERATION.ADD);
                r.record(10, OPERATION.ADD);

                const seen: number[] = [];
                r.forEach((idx) => seen.push(idx));
                assert.deepStrictEqual(seen.sort((a, b) => a - b), [5, 10]);

                r.reset();
                assert.strictEqual(r.has(), false);
            });
        }
    });
});
