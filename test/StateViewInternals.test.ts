import * as assert from "assert";

import { Schema, type, view, ArraySchema, MapSchema, StateView, $changes } from "../src";
import { Root } from "../src/encoder/Root";
import { TypeContext } from "../src/types/TypeContext";
import { ChangeTree } from "../src/encoder/ChangeTree";
import { createClientWithView, encodeMultiple, getEncoder } from "./Schema";

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

    describe("ChangeTree tag bitmap (per-view, per-tag)", () => {
        function bindView(): { view: StateView; state: State } {
            const state = new State();
            getEncoder(state);
            const view = new StateView();
            view.add(state);
            return { view, state };
        }

        it("addTag / hasTagOnTree round-trips the bit", () => {
            const { view, state } = bindView();
            const tree = state[$changes]!;

            assert.strictEqual(view.hasTagOnTree(tree, 1), false, "no bit before addTag");
            view.addTag(tree, 1);
            assert.strictEqual(view.hasTagOnTree(tree, 1), true);
            assert.strictEqual(view.hasTagOnTree(tree, 2), false, "different tag is independent");
        });

        it("removeTag clears only the targeted tag bit for this view", () => {
            const { view, state } = bindView();
            const tree = state[$changes]!;

            view.addTag(tree, 1);
            view.addTag(tree, 2);
            view.removeTag(tree, 1);

            assert.strictEqual(view.hasTagOnTree(tree, 1), false);
            assert.strictEqual(view.hasTagOnTree(tree, 2), true);
        });

        it("two views with same tag write to different bits", () => {
            const state = new State();
            getEncoder(state);
            const v0 = new StateView();
            const v1 = new StateView();
            v0.add(state);
            v1.add(state);
            const tree = state[$changes]!;

            v0.addTag(tree, 7);
            assert.strictEqual(v0.hasTagOnTree(tree, 7), true);
            assert.strictEqual(v1.hasTagOnTree(tree, 7), false, "v1's bit untouched by v0.addTag");

            v0.removeTag(tree, 7);
            v1.addTag(tree, 7);
            assert.strictEqual(v1.hasTagOnTree(tree, 7), true);
        });

        it("dispose clears tag bits so a recycled view ID does not inherit them", () => {
            const state = new State();
            getEncoder(state);
            const tree = state[$changes]!;

            const v1 = new StateView();
            v1.add(state);
            v1.addTag(tree, 5);
            assert.strictEqual(v1.hasTagOnTree(tree, 5), true);

            const reusedId = v1.id;
            v1.dispose();

            const v2 = new StateView();
            // @ts-ignore — bind without add() to observe pre-add state
            v2["_bindRoot"]((state as any)[$changes].root);
            assert.strictEqual(v2.id, reusedId, "ID was reused");
            assert.strictEqual(
                v2.hasTagOnTree(tree, 5),
                false,
                "v2 must NOT inherit v1's tag bit after dispose",
            );
        });
    });

    describe("ID reuse: dispose() must clear leftover bits", () => {
        // Hard contract: when a view is disposed, all bits it set on
        // ChangeTrees are cleared. A future view that acquires the same
        // ID starts with a clean slate. (Not a tradeoff — a privacy
        // requirement, see end-to-end test below.)
        it("a freshly-acquired ID does NOT inherit stale visible bits from the previous owner", () => {
            const state = new State();
            getEncoder(state);

            const v1 = new StateView();
            v1.add(state);
            const tree = state[$changes];
            assert.strictEqual(v1.isVisible(tree), true);

            const reusedId = v1.id;
            v1.dispose();

            const v2 = new StateView();
            // Bind without calling add() so we can observe pre-add state.
            // @ts-ignore — private
            v2["_bindRoot"]((state as any)[$changes].root);
            assert.strictEqual(v2.id, reusedId, "ID was reused");
            assert.strictEqual(
                v2.isVisible(tree),
                false,
                "v2 must NOT inherit v1's visible bit after dispose",
            );
        });

        it("re-add after dispose works (idempotent markVisible)", () => {
            const state = new State();
            getEncoder(state);

            const v1 = new StateView();
            v1.add(state);
            const tree = state[$changes];
            v1.dispose();

            const v2 = new StateView();
            v2.add(state);
            assert.strictEqual(v2.isVisible(tree), true);
        });
    });

    describe("privacy: dispose must clear prior view's bits", () => {
        // End-to-end repro of the stale-bit-on-ID-reuse hazard at the
        // encoded-bytes level. Custom-tagged fields (@view(N)) are gated
        // by view.tags (a WeakMap on the live view, correctly GC'd with
        // the disposed view), so they don't leak. Plain @view() fields
        // ARE gated by the bitmap — that's where the hazard lives.

        // We use a CUSTOM-tag @view(N) so view.add(parent) does NOT
        // auto-recurse into the field. That gives us a window where B's
        // setup does not re-mark the bit, exposing the stale-bit leak.
        const TAG_A_ONLY = 1;
        class Room extends Schema {
            @type("string") code: string = "";
        }
        class World extends Schema {
            @type("string") name: string = "";
            @view(TAG_A_ONLY) @type(Room) restricted = new Room();
        }

        it("a recycled view ID must NOT inherit visibility of a tagged sibling tree", () => {
            // PRIVACY-CRITICAL repro:
            //   1. Client A opts into the @view(TAG_A_ONLY) Room (custom tag
            //      so it isn't auto-recursed by view.add(world)).
            //   2. Client A leaves (dispose).
            //   3. Client B joins, gets A's recycled view ID. B subscribes
            //      to the world only — never to the restricted room.
            //   4. The restricted room mutates.
            //   5. Encode runs — the restricted room's ChangeTree is dirty.
            //   6. Encode loop checks visibility. Stale bit (without fix)
            //      ⇒ B's encode visits the room and emits its untagged
            //      child fields.
            const world = new World().assign({ name: "lobby" });
            world.restricted.code = "INITIAL";
            const encoder = getEncoder(world);

            // Step 1–2: A subscribes to the restricted room via custom tag.
            const clientA = createClientWithView(world);
            clientA.view.add(world);
            clientA.view.add(world.restricted, TAG_A_ONLY);
            encodeMultiple(encoder, world, [clientA]);
            const aId = clientA.view.id;

            // Step 3: A leaves.
            clientA.view.dispose();

            // Step 4: B joins, only subscribes to world. Never opts into
            // the restricted room (no add() with TAG_A_ONLY).
            const clientB = createClientWithView(world);
            clientB.view.add(world);
            assert.strictEqual(clientB.view.id, aId, "precondition: B reuses A's view ID");

            // Step 5: server rotates the restricted code with a sentinel
            // string that's unlikely to collide with any other content on
            // the wire. We check the encoded bytes for this sentinel —
            // the decoder's conservatism may drop unknown refs, but any
            // attacker-controlled decoder will happily parse leaked bytes.
            const SENTINEL = "LEAKED_SENTINEL_ZQJX";
            world.restricted.code = SENTINEL;
            const encodedViews = encodeMultiple(encoder, world, [clientB]);
            const bBytes = encodedViews[0];

            // Step 6: Wire-level privacy contract — the sentinel must not
            // appear in B's encoded bytes at all.
            const bStr = new TextDecoder().decode(bBytes);
            assert.ok(
                !bStr.includes(SENTINEL),
                `PRIVACY LEAK: B's encoded bytes contain restricted (custom-tag) data. Sentinel '${SENTINEL}' found on wire.`,
            );
        });

        it("invisible bits must be cleared on dispose (bitmap level)", () => {
            // Lower-level mirror of the privacy test: the invisibleViews
            // bitmap must also be cleared at dispose. (isVisible is covered
            // by the earlier test; here we pin the parallel invariant.)
            const state = new State();
            getEncoder(state);
            const tree = state[$changes]!;

            const v1 = new StateView();
            v1.add(state);
            v1.markInvisible(tree);
            assert.strictEqual(v1.isInvisible(tree), true, "sanity");

            const v1Id = v1.id;
            v1.dispose();

            const v2 = new StateView();
            // @ts-ignore — bind without calling add() to observe pre-add state
            v2["_bindRoot"]((state as any)[$changes].root);
            assert.strictEqual(v2.id, v1Id, "ID reused");

            assert.strictEqual(
                v2.isInvisible(tree!),
                false,
                "v2 must NOT inherit v1's invisible mark after dispose",
            );
        });
    });
});
