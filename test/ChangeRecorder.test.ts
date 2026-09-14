import * as assert from "assert";
import { OPERATION } from "../src/encoding/spec";
import { SchemaChangeRecorder } from "../src/encoder/ChangeRecorder";

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
});
