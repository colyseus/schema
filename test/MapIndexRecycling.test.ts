import * as assert from "assert";
import { Schema, type, view, MapSchema, StateView } from "../src";
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

});
