import * as assert from "assert";
import { OPERATION } from "../src/encoding/spec";
import { SchemaChangeRecorder, CollectionChangeRecorder, ChangeKind } from "../src/encoder/ChangeRecorder";

describe("ChangeRecorder", () => {

    describe("SchemaChangeRecorder", () => {
        it("records a single change in low mask", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD, false);

            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.has("allChanges"), true);
            assert.strictEqual(r.sizeOf("changes"), 1);
            assert.strictEqual(r.operationAt(3), OPERATION.ADD);
        });

        it("records a change at field 32 (boundary into high mask)", () => {
            const r = new SchemaChangeRecorder(40);
            r.record(32, OPERATION.ADD, false);
            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.sizeOf("changes"), 1);

            const seen: number[] = [];
            r.forEach("changes", (idx) => seen.push(idx));
            assert.deepStrictEqual(seen, [32]);
        });

        it("records multiple changes spanning low and high masks", () => {
            const r = new SchemaChangeRecorder(64);
            r.record(0, OPERATION.ADD, false);
            r.record(31, OPERATION.ADD, false);
            r.record(32, OPERATION.ADD, false);
            r.record(63, OPERATION.ADD, false);

            assert.strictEqual(r.sizeOf("changes"), 4);

            const seen: number[] = [];
            r.forEach("changes", (idx) => seen.push(idx));
            assert.deepStrictEqual(seen.sort((a, b) => a - b), [0, 31, 32, 63]);
        });

        it("merges DELETE+ADD into DELETE_AND_ADD", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.DELETE, false);
            r.record(2, OPERATION.ADD, false);
            assert.strictEqual(r.operationAt(2), OPERATION.DELETE_AND_ADD);
        });

        it("recordDelete adds to dirty but removes from cumulative", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD, false);
            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.has("allChanges"), true);

            r.recordDelete(3, OPERATION.DELETE, false);
            assert.strictEqual(r.has("changes"), true);   // DELETE still queued
            assert.strictEqual(r.has("allChanges"), false); // cumulative cleared
            assert.strictEqual(r.operationAt(3), OPERATION.DELETE);
        });

        it("first ADD wins; subsequent ADD does not change op", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.ADD, false);
            r.record(2, OPERATION.ADD, false);
            assert.strictEqual(r.operationAt(2), OPERATION.ADD);
        });

        it("setOperationAt overrides", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(2, OPERATION.ADD, false);
            r.setOperationAt(2, OPERATION.DELETE);
            assert.strictEqual(r.operationAt(2), OPERATION.DELETE);
        });

        it("filtered records go into filtered masks, not non-filtered", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(1, OPERATION.ADD, true);

            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("allChanges"), false);
            assert.strictEqual(r.has("filteredChanges"), true);
            assert.strictEqual(r.has("allFilteredChanges"), true);
            assert.strictEqual(r.hasFilteredStorage, true);
        });

        it("reset('changes') clears current-tick but not cumulative", () => {
            const r = new SchemaChangeRecorder(8);
            r.record(3, OPERATION.ADD, false);
            r.reset("changes");
            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("allChanges"), true);
        });

        it("forEach iterates in low-then-high order", () => {
            const r = new SchemaChangeRecorder(64);
            r.record(45, OPERATION.ADD, false);
            r.record(2, OPERATION.ADD, false);
            r.record(33, OPERATION.ADD, false);
            r.record(7, OPERATION.ADD, false);

            const seen: number[] = [];
            r.forEach("changes", (idx) => seen.push(idx));
            // low bits ascending, then high bits ascending
            assert.deepStrictEqual(seen, [2, 7, 33, 45]);
        });

        it("promoteToFiltered moves all entries", () => {
            const r = new SchemaChangeRecorder(64);
            r.record(0, OPERATION.ADD, false);
            r.record(35, OPERATION.ADD, false);

            r.promoteToFiltered();

            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("allChanges"), false);
            assert.strictEqual(r.sizeOf("filteredChanges"), 2);
            assert.strictEqual(r.sizeOf("allFilteredChanges"), 2);
            assert.strictEqual(r.hasFilteredStorage, true);
        });

        it("recordPure throws (Schema doesn't use pure ops)", () => {
            const r = new SchemaChangeRecorder(8);
            assert.throws(() => r.recordPure(OPERATION.CLEAR, false));
        });

        it("operationAt returns undefined for unrecorded indexes", () => {
            const r = new SchemaChangeRecorder(8);
            assert.strictEqual(r.operationAt(5), undefined);
        });

        it("sizeOf is precise via popcount", () => {
            const r = new SchemaChangeRecorder(64);
            for (let i = 0; i < 50; i++) r.record(i, OPERATION.ADD, false);
            assert.strictEqual(r.sizeOf("changes"), 50);
        });
    });

    describe("CollectionChangeRecorder", () => {
        it("records sparse indexes (e.g., 0, 7, 1024)", () => {
            const r = new CollectionChangeRecorder();
            r.record(0, OPERATION.ADD, false);
            r.record(7, OPERATION.ADD, false);
            r.record(1024, OPERATION.ADD, false);

            assert.strictEqual(r.sizeOf("changes"), 3);

            const seen: number[] = [];
            r.forEach("changes", (idx) => seen.push(idx));
            // Map iteration order is insertion order
            assert.deepStrictEqual(seen, [0, 7, 1024]);
        });

        it("merges DELETE+ADD into DELETE_AND_ADD", () => {
            const r = new CollectionChangeRecorder();
            r.record(5, OPERATION.DELETE, false);
            r.record(5, OPERATION.ADD, false);
            assert.strictEqual(r.operationAt(5), OPERATION.DELETE_AND_ADD);
        });

        it("recordDelete adds to dirty but removes from cumulative", () => {
            const r = new CollectionChangeRecorder();
            r.record(7, OPERATION.ADD, false);
            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.has("allChanges"), true);

            r.recordDelete(7, OPERATION.DELETE, false);
            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.has("allChanges"), false);
            assert.strictEqual(r.operationAt(7), OPERATION.DELETE);
        });

        it("filtered records go into filtered store (lazy alloc)", () => {
            const r = new CollectionChangeRecorder();
            assert.strictEqual(r.hasFilteredStorage, false);

            r.record(2, OPERATION.ADD, true);

            assert.strictEqual(r.hasFilteredStorage, true);
            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("filteredChanges"), true);
        });

        it("recordPure stores CLEAR/REVERSE for current-tick iteration", () => {
            const r = new CollectionChangeRecorder();
            r.record(0, OPERATION.ADD, false);
            r.recordPure(OPERATION.CLEAR, false);

            assert.strictEqual(r.sizeOf("changes"), 2);

            const seen: Array<[number, number]> = [];
            r.forEach("changes", (idx, op) => seen.push([idx, op]));

            // Indexed first (Map order), then pure ops as negative values
            assert.deepStrictEqual(seen, [
                [0, OPERATION.ADD],
                [-OPERATION.CLEAR, OPERATION.CLEAR],
            ]);
        });

        it("pure ops aren't replayed in 'allChanges' (only in 'changes')", () => {
            const r = new CollectionChangeRecorder();
            r.recordPure(OPERATION.CLEAR, false);

            // pure ops belong to current-tick only — they're already destructive
            assert.strictEqual(r.has("changes"), true);
            assert.strictEqual(r.has("allChanges"), false);
        });

        it("reset clears the right kind", () => {
            const r = new CollectionChangeRecorder();
            r.record(1, OPERATION.ADD, false);
            r.record(2, OPERATION.ADD, false);

            r.reset("changes");
            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("allChanges"), true);  // cumulative remains

            r.reset("allChanges");
            assert.strictEqual(r.has("allChanges"), false);
        });

        it("promoteToFiltered moves entries and clears originals", () => {
            const r = new CollectionChangeRecorder();
            r.record(7, OPERATION.ADD, false);
            r.recordPure(OPERATION.CLEAR, false);

            r.promoteToFiltered();

            assert.strictEqual(r.has("changes"), false);
            assert.strictEqual(r.has("allChanges"), false);
            assert.strictEqual(r.sizeOf("filteredChanges"), 2);
            assert.strictEqual(r.sizeOf("allFilteredChanges"), 1);
        });

        it("operationAt is shared across all kinds", () => {
            const r = new CollectionChangeRecorder();
            r.record(3, OPERATION.ADD, false);
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
                const kinds: ChangeKind[] = ["changes", "allChanges", "filteredChanges", "allFilteredChanges"];
                for (const k of kinds) {
                    assert.strictEqual(r.has(k), false, `has(${k})`);
                    assert.strictEqual(r.sizeOf(k), 0, `sizeOf(${k})`);
                    let count = 0;
                    r.forEach(k, () => count++);
                    assert.strictEqual(count, 0, `forEach(${k})`);
                }
            });

            it(`${name}: record + iterate cycle`, () => {
                const r = factory();
                r.record(5, OPERATION.ADD, false);
                r.record(10, OPERATION.ADD, false);

                const seen: number[] = [];
                r.forEach("changes", (idx) => seen.push(idx));
                assert.deepStrictEqual(seen.sort((a, b) => a - b), [5, 10]);

                r.reset("changes");
                assert.strictEqual(r.has("changes"), false);
                assert.strictEqual(r.has("allChanges"), true); // cumulative survives
            });

            it(`${name}: filtered isolation`, () => {
                const r = factory();
                r.record(1, OPERATION.ADD, false);
                r.record(2, OPERATION.ADD, true);

                assert.strictEqual(r.sizeOf("changes"), 1);
                assert.strictEqual(r.sizeOf("filteredChanges"), 1);
            });
        }
    });
});
