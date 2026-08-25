import * as assert from "assert";
import { ChangeTree, Schema, type, view, $changes, ArraySchema, MapSchema, Encoder } from "../src";
import { assertDeepStrictEqualEncodeAll, createInstanceFromReflection, encodeAndAssertEquals } from "./Schema";

describe("Parent Chain", () => {
    class Item extends Schema {
        @type("string") name: string = "";
        @type("number") value: number = 0;
    }

    class Inventory extends Schema {
        @type({ map: Item }) items = new MapSchema<Item>();
    }

    class State extends Schema {
        @type({ map: Inventory }) inventories = new MapSchema<Inventory>();
    }

    it("should track multiple parents efficiently", () => {
        const state = new State();
        const inventory1 = new Inventory();
        const inventory2 = new Inventory();
        const sharedItem = new Item();
        sharedItem.name = "Sword";
        sharedItem.value = 100;

        // Add inventories to state
        state.inventories.set("player1", inventory1);
        state.inventories.set("player2", inventory2);

        // Add the same item to multiple inventories (shared reference)
        inventory1.items.set("sword", sharedItem);
        inventory2.items.set("sword", sharedItem);

        const decodedState = createInstanceFromReflection(state);
        encodeAndAssertEquals(state, decodedState);
        assertDeepStrictEqualEncodeAll(state, false);

        const sharedItemChangeTree = sharedItem[$changes] as ChangeTree;

        // Verify that the shared item has multiple parents
        const itemParents = sharedItemChangeTree.getAllParents();
        assert.strictEqual(itemParents.length, 2, "Item should have 2 parents (MapSchema collections)");

        // Verify the parent chain contains both MapSchema collections (the items collections)
        const hasInventory1Items = sharedItemChangeTree.hasParent((parent, index) => parent === inventory1.items);
        const hasInventory2Items = sharedItemChangeTree.hasParent((parent, index) => parent === inventory2.items);
        assert.strictEqual(hasInventory1Items, true, "Item should have inventory1.items as parent");
        assert.strictEqual(hasInventory2Items, true, "Item should have inventory2.items as parent");

        // Test findParent method
        const foundInventory1Items = sharedItemChangeTree.findParent((parent, index) => parent === inventory1.items);
        const foundInventory2Items = sharedItemChangeTree.findParent((parent, index) => parent === inventory2.items);
        assert.notStrictEqual(foundInventory1Items, undefined, "Should find inventory1.items as parent");
        assert.notStrictEqual(foundInventory2Items, undefined, "Should find inventory2.items as parent");
        assert.strictEqual(foundInventory1Items!.ref, inventory1.items, "Should return correct parent reference");
        assert.strictEqual(foundInventory2Items!.ref, inventory2.items, "Should return correct parent reference");

        // Test immediate parent (should be the last one added)
        assert.strictEqual(sharedItemChangeTree.parent, inventory2.items, "Immediate parent should be inventory2.items");
        assert.strictEqual(sharedItemChangeTree.parentIndex, 0, "Parent index should be 0");

        // Test addParent method
        const testInventory = new Inventory();
        sharedItemChangeTree.addParent(testInventory, 5);
        assert.strictEqual(sharedItemChangeTree.parent, testInventory, "Immediate parent should be testInventory");
        assert.strictEqual(sharedItemChangeTree.parentIndex, 5, "Parent index should be 5");

        // Test removeImmediateParent method
        sharedItemChangeTree.removeParent(sharedItemChangeTree.parent);
        assert.strictEqual(sharedItemChangeTree.parent, inventory2.items, "Immediate parent should be inventory2.items again");
        assert.strictEqual(sharedItemChangeTree.parentIndex, 0, "Parent index should be 0");

        // Verify parent count after removal
        const itemParentsAfterRemoval = sharedItemChangeTree.getAllParents();
        assert.strictEqual(itemParentsAfterRemoval.length, 2, "Item should still have 2 parents after removal");
    });

    it("should handle empty parent chain", () => {
        const item = new Item();
        const itemChangeTree = item[$changes] as ChangeTree;

        assert.strictEqual(itemChangeTree.parent, undefined);
        assert.strictEqual(itemChangeTree.parentIndex, undefined);
        assert.deepStrictEqual(itemChangeTree.getAllParents(), []);
        assert.strictEqual(itemChangeTree.findParent(() => true), undefined);
        assert.strictEqual(itemChangeTree.hasParent(() => true), false);
    });

    it("should handle complex parent chains with multiple levels", () => {
        const state = new State();
        const inventory1 = new Inventory();
        const inventory2 = new Inventory();
        const sharedItem = new Item();
        sharedItem.name = "Potion";
        sharedItem.value = 50;

        // Create a complex hierarchy
        state.inventories.set("player1", inventory1);
        state.inventories.set("player2", inventory2);
        inventory1.items.set("potion", sharedItem);
        inventory2.items.set("potion", sharedItem);

        // Trigger encoding to establish parent relationships
        const encoder = new Encoder(state);
        encoder.encodeAll();

        const sharedItemChangeTree = sharedItem[$changes] as ChangeTree;

        // Verify parent chain structure
        const parents = sharedItemChangeTree.getAllParents();
        assert.strictEqual(parents.length, 2, "Item should have 2 parent MapSchema collections");

        // Verify both parents are MapSchema collections
        const parentTypes = parents.map(p => p.ref.constructor.name);
        assert.deepStrictEqual(parentTypes, ["MapSchema", "MapSchema"], "Both parents should be MapSchema instances");

        // Test that we can find specific parents
        const foundInInventory1 = sharedItemChangeTree.findParent((parent, index) =>
            parent === inventory1.items && index === 0);
        const foundInInventory2 = sharedItemChangeTree.findParent((parent, index) =>
            parent === inventory2.items && index === 0);

        assert.notStrictEqual(foundInInventory1, undefined, "Should find item in inventory1.items");
        assert.notStrictEqual(foundInInventory2, undefined, "Should find item in inventory2.items");
        assert.strictEqual(foundInInventory1!.ref, inventory1.items, "Should return correct parent reference");
        assert.strictEqual(foundInInventory2!.ref, inventory2.items, "Should return correct parent reference");
    });

    it("should not add duplicate parents", () => {
        const item = new Item();
        const inventory1 = new Inventory();
        const inventory2 = new Inventory();
        const itemChangeTree = item[$changes] as ChangeTree;

        // Add a parent
        itemChangeTree.addParent(inventory1, 1);
        assert.strictEqual(itemChangeTree.parent, inventory1);
        assert.strictEqual(itemChangeTree.parentIndex, 1);
        assert.strictEqual(itemChangeTree.getAllParents().length, 1);

        // Try to add the same parent again
        itemChangeTree.addParent(inventory1, 1);
        assert.strictEqual(itemChangeTree.parent, inventory1);
        assert.strictEqual(itemChangeTree.parentIndex, 1);
        assert.strictEqual(itemChangeTree.getAllParents().length, 1, "Should not add duplicate parent");

        // Add a different parent
        itemChangeTree.addParent(inventory2, 2);
        assert.strictEqual(itemChangeTree.parent, inventory2);
        assert.strictEqual(itemChangeTree.parentIndex, 2);
        assert.strictEqual(itemChangeTree.getAllParents().length, 2);

        // Try to add the same parent again with different index
        itemChangeTree.addParent(inventory1, 3);
        assert.strictEqual(itemChangeTree.parent, inventory2);
        assert.strictEqual(itemChangeTree.parentIndex, 3);
        assert.strictEqual(itemChangeTree.getAllParents().length, 2, "Should add parent with different index");

        // Try to add the same parent with same index again
        itemChangeTree.addParent(inventory1, 3);
        assert.strictEqual(itemChangeTree.parent, inventory2);
        assert.strictEqual(itemChangeTree.parentIndex, 3);
        assert.strictEqual(itemChangeTree.getAllParents().length, 2, "Should not add duplicate parent with same index");
    });

    it("findParent / getAllParents hand out detached copies", () => {
        // The inline parent has no chain node to return, so these helpers have
        // to fabricate one for it. Returning the live node for the
        // `extraParents` case only would mean a write lands or vanishes
        // depending on which parent happened to match. Both are copies.
        const state = new State();
        const inventory1 = new Inventory();
        const inventory2 = new Inventory();
        const shared = new Item();
        state.inventories.set("p1", inventory1);
        state.inventories.set("p2", inventory2);
        inventory1.items.set("sword", shared);
        inventory2.items.set("sword", shared);

        const tree = shared[$changes] as ChangeTree;
        const before = tree.getAllParents().map((p) => p.index);
        assert.strictEqual(before.length, 2, "fixture should give the item two parents");

        // `readonly` blocks this at compile time; the cast proves the runtime
        // copy is what actually protects the chain.
        for (const parent of [inventory1.items, inventory2.items]) {
            const found = tree.findParent((ref) => ref === parent)!;
            (found as { index: number }).index = 99;
            assert.notStrictEqual(tree.indexInParent(parent), 99, "write leaked into the live chain");
        }
        (tree.getAllParents()[0] as { index: number }).index = 99;

        assert.deepStrictEqual(tree.getAllParents().map((p) => p.index), before);
    });

    describe("array children track their wire slot", () => {
        // `parentIndex` is the child's slot in the parent's wire index space
        // (ArraySchema#tmpItems). StateView addresses per-view ADD/DELETE with
        // it, so a reindex that leaves it behind aims those ops at whichever
        // element inherited the slot — see issue #231.
        //
        // `rows` is @view-tagged on purpose: a filtered array is the only one
        // whose slots are ever read back, so it is the only one the encoder
        // keeps current. Drop the tag and every case below fails.
        class Row extends Schema {
            @type("string") text: string = "";
        }
        class ArrayState extends Schema {
            @view() @type([Row]) rows = new ArraySchema<Row>();
        }

        function row(text: string) {
            const instance = new Row();
            instance.text = text;
            return instance;
        }

        /** `n` rows named "a", "b", … already encoded, so nothing is pending. */
        function fixture(n: number) {
            const state = new ArrayState();
            const encoder = new Encoder(state);
            for (let i = 0; i < n; i++) { state.rows.push(row(String.fromCharCode(97 + i))); }
            const flush = () => { encoder.encode(); encoder.discardChanges(); };
            flush();
            return { state, flush };
        }

        /** Renders as "text@slot", annotating any slot that drifted. */
        function assertWireSlots(state: ArrayState, expected: string) {
            const slots = [...state.rows].map((r, i) => {
                const slot = r[$changes].parentIndex;
                return `${r.text}@${slot}${slot === i ? "" : `(want ${i})`}`;
            });
            assert.strictEqual(slots.join(","), expected);
        }

        const cases: Array<[string, (state: ArrayState) => void, string]> = [
            ["shift()", (s) => s.rows.shift(), "b@0,c@1,d@2"],
            ["pop()", (s) => s.rows.pop(), "a@0,b@1,c@2"],
            ["splice() at head", (s) => s.rows.splice(0, 1), "b@0,c@1,d@2"],
            ["splice() in the middle", (s) => s.rows.splice(1, 2), "a@0,d@1"],
            ["splice() at tail", (s) => s.rows.splice(3, 1), "a@0,b@1,c@2"],
            ["reverse()", (s) => s.rows.reverse(), "d@0,c@1,b@2,a@3"],
            ["sort()", (s) => s.rows.sort((x, y) => y.text.localeCompare(x.text)), "d@0,c@1,b@2,a@3"],
            ["unshift()", (s) => s.rows.unshift(row("x")), "x@0,a@1,b@2,c@3,d@4"],
        ];

        cases.forEach(([name, mutate, expected]) => {
            it(name, () => {
                const { state, flush } = fixture(4);
                mutate(state);
                flush();
                assertWireSlots(state, expected);
            });
        });

        it("a same-tick pop + push renumbers the appended row", () => {
            // push reserves the slot past the staged tail; compaction then
            // closes the popped hole underneath it
            const { state, flush } = fixture(3);
            state.rows.pop();
            state.rows.push(row("d"));
            flush();
            assertWireSlots(state, "a@0,b@1,d@2");
        });
    });
});
