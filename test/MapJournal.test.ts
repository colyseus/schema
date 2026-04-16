import * as assert from "assert";
import { MapJournal } from "../src/encoder/MapJournal";

describe("MapJournal", () => {
    describe("server-side index assignment", () => {
        it("assigns sequential indexes starting at 0", () => {
            const j = new MapJournal<string>();
            assert.strictEqual(j.assign("a"), 0);
            assert.strictEqual(j.assign("b"), 1);
            assert.strictEqual(j.assign("c"), 2);
        });

        it("indexOf returns undefined for unseen keys", () => {
            const j = new MapJournal<string>();
            assert.strictEqual(j.indexOf("nope"), undefined);
        });

        it("indexOf returns the assigned index for seen keys", () => {
            const j = new MapJournal<string>();
            j.assign("foo");
            j.assign("bar");
            assert.strictEqual(j.indexOf("foo"), 0);
            assert.strictEqual(j.indexOf("bar"), 1);
        });

        it("keyOf returns the key for an assigned index", () => {
            const j = new MapJournal<string>();
            j.assign("alice");
            j.assign("bob");
            assert.strictEqual(j.keyOf(0), "alice");
            assert.strictEqual(j.keyOf(1), "bob");
        });

        it("keyOf returns undefined for unassigned index", () => {
            const j = new MapJournal<string>();
            assert.strictEqual(j.keyOf(99), undefined);
        });
    });

    describe("snapshots", () => {
        it("snapshot + snapshotAt round-trip", () => {
            const j = new MapJournal<string>();
            const value = { foo: "bar" };
            j.snapshot(0, value);
            assert.strictEqual(j.snapshotAt(0), value);
        });

        it("snapshotAt returns undefined when no snapshot", () => {
            const j = new MapJournal<string>();
            assert.strictEqual(j.snapshotAt(0), undefined);
        });

        it("forgetSnapshot removes a snapshot", () => {
            const j = new MapJournal<string>();
            j.snapshot(0, "a");
            j.forgetSnapshot(0);
            assert.strictEqual(j.snapshotAt(0), undefined);
        });
    });

    describe("decoder-side setIndex", () => {
        it("setIndex maintains both directions", () => {
            const j = new MapJournal<string>();
            j.setIndex(5, "alice");
            assert.strictEqual(j.keyOf(5), "alice");
            assert.strictEqual(j.indexOf("alice"), 5);
        });

        it("setIndex doesn't advance the server-side counter", () => {
            const j = new MapJournal<string>();
            j.setIndex(10, "remote");
            // Server-side assign should still start from 0
            assert.strictEqual(j.assign("local"), 0);
        });
    });

    describe("cleanupAfterEncode", () => {
        it("removes entries whose snapshots are present", () => {
            const j = new MapJournal<string>();
            j.assign("a");
            j.assign("b");
            j.assign("c");
            // 'b' was deleted this tick
            j.snapshot(1, "b's value");

            j.cleanupAfterEncode();

            assert.strictEqual(j.indexOf("b"), undefined);
            assert.strictEqual(j.keyOf(1), undefined);
            assert.strictEqual(j.snapshotAt(1), undefined);
            // a and c are unaffected
            assert.strictEqual(j.indexOf("a"), 0);
            assert.strictEqual(j.indexOf("c"), 2);
        });

        it("clears the snapshots map", () => {
            const j = new MapJournal<string>();
            j.assign("a");
            j.snapshot(0, "x");
            j.cleanupAfterEncode();
            assert.strictEqual(j.snapshots.size, 0);
        });
    });

    describe("reset", () => {
        it("clears all state", () => {
            const j = new MapJournal<string>();
            j.assign("a");
            j.assign("b");
            j.snapshot(0, "v");

            j.reset();

            assert.strictEqual(j.indexOf("a"), undefined);
            assert.strictEqual(j.keyOf(0), undefined);
            assert.strictEqual(j.snapshotAt(0), undefined);
            // counter resets — next assign starts at 0 again
            assert.strictEqual(j.assign("c"), 0);
        });
    });

    describe("typical lifecycle", () => {
        it("simulates a full encode tick: add, delete, encode, cleanup", () => {
            const j = new MapJournal<string>();

            // tick 1: add three players
            const i1 = j.assign("p1"); assert.strictEqual(i1, 0);
            const i2 = j.assign("p2"); assert.strictEqual(i2, 1);
            const i3 = j.assign("p3"); assert.strictEqual(i3, 2);

            // tick 2: delete p2
            const idx = j.indexOf("p2")!;
            j.snapshot(idx, "p2's data");

            // encoder iterates and reads snapshots for visibility checks
            assert.strictEqual(j.snapshotAt(idx), "p2's data");

            // post-encode cleanup
            j.cleanupAfterEncode();

            // p2's slot is now gone
            assert.strictEqual(j.indexOf("p2"), undefined);
            assert.strictEqual(j.keyOf(1), undefined);

            // p1 and p3 still mapped
            assert.strictEqual(j.indexOf("p1"), 0);
            assert.strictEqual(j.indexOf("p3"), 2);

            // adding a new key gets index 3 (the counter doesn't reuse slot 1)
            assert.strictEqual(j.assign("p4"), 3);
        });
    });
});
