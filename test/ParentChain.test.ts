import * as assert from "assert";
import { ChangeTree, Schema, type, $changes, MapSchema, Encoder } from "../src";
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
        assert.strictEqual(itemChangeTree.parentIndex, 2);
        assert.strictEqual(itemChangeTree.getAllParents().length, 2, "Should add parent with different index");

        // Try to add the same parent with same index again
        itemChangeTree.addParent(inventory1, 3);
        assert.strictEqual(itemChangeTree.parent, inventory2);
        assert.strictEqual(itemChangeTree.parentIndex, 2);
        assert.strictEqual(itemChangeTree.getAllParents().length, 2, "Should not add duplicate parent with same index");
    });
});