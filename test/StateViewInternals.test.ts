import * as assert from "assert";

import { Schema, type, MapSchema, StateView, $changes } from "../src";
import { Root } from "../src/encoder/Root";
import { TypeContext } from "../src/types/TypeContext";
import { ChangeTree } from "../src/encoder/ChangeTree";
import { getEncoder } from "./Schema";

/**
 * Internal-mechanics tests for StateView. Complements StateView.test.ts
 * (encoding behavior) by exercising the per-Root view-ID allocator, the
 * per-ChangeTree visibility bitmap, and the dispose lifecycle directly.
 */
describe("StateView internals", () => {

    class Item extends Schema {
        @type("number") n: number = 0;
    }
    class State extends Schema {
        @type({ map: Item }) items = new MapSchema<Item>();
    }

    function freshRoot(): Root {
        return new Root(new TypeContext());
    }

    describe("Root view ID allocator", () => {
        it("hands out 0, 1, 2, ... sequentially when nothing is freed", () => {
            const root = freshRoot();
            assert.strictEqual(root.acquireViewId(), 0);
            assert.strictEqual(root.acquireViewId(), 1);
            assert.strictEqual(root.acquireViewId(), 2);
        });

        it("releaseViewId puts ID back on the freelist", () => {
            const root = freshRoot();
            const a = root.acquireViewId(); // 0
            const b = root.acquireViewId(); // 1
            const c = root.acquireViewId(); // 2
            root.releaseViewId(b);            // free 1
            assert.strictEqual(root.acquireViewId(), 1, "should reuse freed ID 1");
            // No more frees, next is 3 from the counter
            assert.strictEqual(root.acquireViewId(), 3);
            // Free a + c, then re-acquire — LIFO order from .pop()
            root.releaseViewId(a);
            root.releaseViewId(c);
            assert.strictEqual(root.acquireViewId(), 2, "LIFO: c (2) released last → handed out first");
            assert.strictEqual(root.acquireViewId(), 0);
        });

        it("two Roots each have independent ID spaces", () => {
            const r1 = freshRoot();
            const r2 = freshRoot();
            assert.strictEqual(r1.acquireViewId(), 0);
            assert.strictEqual(r2.acquireViewId(), 0, "second Root starts at 0 too");
            assert.strictEqual(r1.acquireViewId(), 1);
        });
    });

    describe("StateView lifecycle", () => {
        it("id is -1 until first add() binds to a Root", () => {
            const view = new StateView();
            assert.strictEqual(view.id, -1);
        });

        it("first add() acquires an ID from the encoder's Root", () => {
            const state = new State();
            const encoder = getEncoder(state);
            const view = new StateView();

            view.add(state);
            assert.notStrictEqual(view.id, -1, "view should have an assigned ID");
            assert.strictEqual(view.id, 0, "first view on this Root gets ID 0");
            assert.strictEqual(view.id, encoder.root.acquireViewId() - 1, "next acquire returns the next ID");
        });

        it("dispose() returns ID to the freelist", () => {
            const state = new State();
            const encoder = getEncoder(state);

            const v1 = new StateView();
            v1.add(state);
            const id1 = v1.id;

            const v2 = new StateView();
            v2.add(state);
            assert.notStrictEqual(v2.id, id1, "fresh ID, not reused");

            v1.dispose();
            assert.strictEqual(v1.id, -1, "dispose clears local id");

            const v3 = new StateView();
            v3.add(state);
            assert.strictEqual(v3.id, id1, "v3 should reuse v1's freed ID");
        });

        it("dispose() on an unbound view is a no-op", () => {
            const view = new StateView();
            assert.doesNotThrow(() => view.dispose());
            assert.strictEqual(view.id, -1);
        });

        it("dispose() called twice is a no-op the second time", () => {
            const state = new State();
            getEncoder(state);
            const view = new StateView();
            view.add(state);

            view.dispose();
            assert.doesNotThrow(() => view.dispose());
            assert.strictEqual(view.id, -1);
        });
    });

    describe("ChangeTree visibility bitmap", () => {
        function makeTree(): ChangeTree {
            // A bare ChangeTree just to exercise the bitmap fields. We
            // never attach it to a Root, so encode-side state is irrelevant.
            const state = new State();
            return state[$changes];
        }

        function bindView(): { view: StateView; encoder: any } {
            const state = new State();
            const encoder = getEncoder(state);
            const view = new StateView();
            view.add(state); // binds + acquires ID
            return { view, encoder };
        }

        it("tree with no bitmap returns false from isVisible/isInvisible", () => {
            const { view } = bindView();
            const tree = makeTree();
            assert.strictEqual(view.isVisible(tree), false);
            assert.strictEqual(view.isInvisible(tree), false);
            assert.strictEqual(tree.visibleViews, undefined);
            assert.strictEqual(tree.invisibleViews, undefined);
        });

        it("markVisible / unmarkVisible round-trips the bit", () => {
            const { view } = bindView();
            const tree = makeTree();

            view.markVisible(tree);
            assert.strictEqual(view.isVisible(tree), true);
            assert.notStrictEqual(tree.visibleViews, undefined);

            view.unmarkVisible(tree);
            assert.strictEqual(view.isVisible(tree), false);
        });

        it("markInvisible / unmarkInvisible round-trips the bit", () => {
            const { view } = bindView();
            const tree = makeTree();

            view.markInvisible(tree);
            assert.strictEqual(view.isInvisible(tree), true);

            view.unmarkInvisible(tree);
            assert.strictEqual(view.isInvisible(tree), false);
        });

        it("visible and invisible bitmaps are independent", () => {
            const { view } = bindView();
            const tree = makeTree();

            view.markVisible(tree);
            view.markInvisible(tree);
            assert.strictEqual(view.isVisible(tree), true);
            assert.strictEqual(view.isInvisible(tree), true);

            view.unmarkVisible(tree);
            assert.strictEqual(view.isVisible(tree), false);
            assert.strictEqual(view.isInvisible(tree), true, "invisible bit unchanged");
        });

        it("two views write to different bits in the same slot", () => {
            const state = new State();
            getEncoder(state);
            const v0 = new StateView();
            const v1 = new StateView();
            v0.add(state);
            v1.add(state);

            const tree = makeTree();
            v0.markVisible(tree);

            assert.strictEqual(v0.isVisible(tree), true);
            assert.strictEqual(v1.isVisible(tree), false, "v1's bit untouched");

            v1.markVisible(tree);
            assert.strictEqual(v0.isVisible(tree), true);
            assert.strictEqual(v1.isVisible(tree), true);

            v0.unmarkVisible(tree);
            assert.strictEqual(v0.isVisible(tree), false);
            assert.strictEqual(v1.isVisible(tree), true, "v0 unmark must not clear v1's bit");
        });

        it("view ID >= 32 lands in slot 1 (chunked bitmap grows)", () => {
            const state = new State();
            const encoder = getEncoder(state);
            // Burn 32 IDs (creating 32 views without dispose so the
            // counter advances)
            for (let i = 0; i < 32; i++) {
                const v = new StateView();
                v.add(state); // claims id i
            }

            const v32 = new StateView();
            v32.add(state);
            assert.strictEqual(v32.id, 32, "32 views taken → next is ID 32");

            const tree = makeTree();
            v32.markVisible(tree);

            assert.notStrictEqual(tree.visibleViews, undefined);
            assert.ok(tree.visibleViews!.length >= 2, "bitmap must have at least 2 slots for ID 32");
            assert.strictEqual(tree.visibleViews![0], 0, "slot 0 untouched");
            assert.strictEqual(tree.visibleViews![1], 1, "slot 1 bit 0 (= 1<<(32&31)) is set");
            assert.strictEqual(v32.isVisible(tree), true);
        });

        it("view ID >= 64 lands in slot 2", () => {
            const state = new State();
            getEncoder(state);
            for (let i = 0; i < 64; i++) {
                const v = new StateView();
                v.add(state);
            }
            const v64 = new StateView();
            v64.add(state);
            assert.strictEqual(v64.id, 64);

            const tree = makeTree();
            v64.markVisible(tree);
            assert.ok(tree.visibleViews!.length >= 3);
            assert.strictEqual(tree.visibleViews![2], 1);
        });

        it("hot-path slot/bit are cached on the view, not recomputed per call", () => {
            // White-box: the cached fields drive the bitmap math. Verify
            // they reflect the assigned ID so that future refactors that
            // forget to update them are caught immediately.
            const state = new State();
            getEncoder(state);
            const v = new StateView();
            v.add(state);

            // @ts-ignore — accessing private fields for the test
            assert.strictEqual(v["_slot"], v.id >> 5);
            // @ts-ignore
            assert.strictEqual(v["_bit"], 1 << (v.id & 31));
        });
    });

    describe("ID reuse stale-bit hazard", () => {
        // Documented design tradeoff: when a view is disposed, any
        // visibility bits it set on ChangeTrees are NOT cleared. If a
        // new view acquires the same ID, those stale bits make the new
        // view think it can already see those trees.
        //
        // These tests pin the current behavior so a future change to the
        // contract is intentional, not accidental.
        it("a freshly-acquired ID can inherit stale bits from the previous owner", () => {
            const state = new State();
            getEncoder(state);

            const v1 = new StateView();
            v1.add(state);
            const tree = state[$changes];
            // (state was already markVisible'd by v1.add(); leave it.)
            assert.strictEqual(v1.isVisible(tree), true);

            const reusedId = v1.id; // capture BEFORE dispose nulls it
            v1.dispose();

            // v2 takes the same ID — the bit on `state` from v1 is still
            // set in the bitmap. v2.isVisible(state) returns true even
            // though v2 never explicitly added it.
            const v2 = new StateView();
            // Bind v2 manually (without calling add) so we can observe
            // the pre-add visibility state inherited from v1's leftover bits.
            // @ts-ignore — private
            v2["_bindRoot"]((state as any)[$changes].root);
            assert.strictEqual(v2.id, reusedId, "ID was reused");
            assert.strictEqual(
                v2.isVisible(tree),
                true,
                "stale-bit hazard: v2 sees v1's old marks. Documented tradeoff.",
            );
        });

        it("calling v2.add() on a tree that has stale bits is still correct (idempotent)", () => {
            // The hazard is only that v2 might SKIP an explicit add or
            // emit nothing because it thinks the tree is already visible.
            // For the encode loop the consequence is missed re-bootstrap;
            // for view.add() the markVisible is idempotent.
            const state = new State();
            getEncoder(state);

            const v1 = new StateView();
            v1.add(state);
            const tree = state[$changes];
            v1.dispose();

            const v2 = new StateView();
            v2.add(state); // re-marks visible, no error
            assert.strictEqual(v2.isVisible(tree), true);
        });
    });
});
