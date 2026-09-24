import * as assert from "assert";
import { Schema, type, view, MapSchema, StateView, $refId } from "../src";
import { createClientWithView, encodeAllForView, encodeMultiple, getEncoder } from "./Schema";

class Item extends Schema {
    @type("number") v: number = 0;
}
class FilteredState extends Schema {
    @view() @type({ map: Item }) items = new MapSchema<Item>();
}

const keysOf = (map: MapSchema<any>) => Array.from(map.keys());

describe("MapSchema wire-index recycling", () => {

    describe("live walk order", () => {
        it("view bootstrap delivers entries in the server's $items order", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            for (const k of ["a", "b", "c"]) state.items.set(k, new Item().assign({ v: 1 }));
            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // same-tick delete + re-set: "a" keeps index 0 but moves to the end of $items
            state.items.delete("a");
            state.items.set("a", new Item().assign({ v: 2 }));
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(state.items), ["b", "c", "a"]);

            client.view.add(state.items);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["b", "c", "a"]);
            assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

            const late = createClientWithView(state, client.view);
            encodeAllForView(encoder, late);
            assert.deepStrictEqual(keysOf(late.state.items), ["b", "c", "a"]);
        });
    });

    describe("Root.pendingViewChanges", () => {
        it("lists the views not drained this tick, once per encodeEpoch", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item());
            const drained = createClientWithView(state);
            const skipped = createClientWithView(state);
            drained.view.add(state.items.get("a")!);
            skipped.view.add(state.items.get("a")!);

            encodeMultiple(encoder, state, [drained]);
            const root = encoder.root;
            const pending = root.pendingViewChanges();
            assert.deepStrictEqual(pending, [skipped.view.changes]);

            skipped.view.changes.clear();
            assert.strictEqual(root.pendingViewChanges(), pending, "cached within the epoch");
            assert.strictEqual(pending.length, 1);
            encoder.discardChanges();
            assert.deepStrictEqual(root.pendingViewChanges(), []);
        });

        it("view.remove binds an unbound view", () => {
            const state = new FilteredState();
            getEncoder(state);
            state.items.set("a", new Item());
            const view = new StateView();
            view.remove(state.items.get("a")!);
            assert.notStrictEqual(view.id, -1);
        });
    });

    describe("StateView entries are written only by the index's holder", () => {
        it("view.add / view.remove of a child removed in an earlier tick write nothing on the map", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            state.items.set("b", new Item().assign({ v: 2 }));
            const client = createClientWithView(state);
            const a = state.items.get("a")!;
            client.view.add(a);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["a"]);

            state.items.delete("a");
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);

            const refId = state.items[$refId];
            client.view.remove(a);
            assert.strictEqual(client.view.changes.get(refId)?.has(0) ?? false, false);
            client.view.add(a);
            assert.strictEqual(client.view.changes.get(refId)?.has(0) ?? false, false);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);
        });

        it("view.remove of a child replaced this tick still deletes it", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            const client = createClientWithView(state);
            const a1 = state.items.get("a")!;
            client.view.add(a1);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["a"]);

            state.items.set("a", new Item().assign({ v: 2 })); // not visible to the view
            client.view.remove(a1);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);
        });
    });

});
