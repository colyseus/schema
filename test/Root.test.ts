import * as assert from "assert";

import { $changes, Encoder, MapSchema, Reflection, Schema, type } from "../src";

describe("Encoder Root", () => {
    it("does not revisit predecessors when removing a nested schema", () => {
        class Leaf extends Schema {
            @type("number") value = 0;
        }

        class Branch extends Schema {
            @type({ map: Leaf }) children = new MapSchema<Leaf>();
        }

        class State extends Schema {
            @type({ map: Leaf }) noise = new MapSchema<Leaf>();
            @type({ map: Branch }) actors = new MapSchema<Branch>();
            @type({ map: Leaf }) trailing = new MapSchema<Leaf>();
        }

        const state = new State();
        for (let index = 0; index < 32; index++) {
            state.noise.set(`noise-${index}`, new Leaf().assign({ value: index }));
        }

        const actor = new Branch();
        for (let index = 0; index < 5; index++) {
            actor.children.set(`child-${index}`, new Leaf().assign({ value: index }));
        }
        state.actors.set("departing", actor);

        const trailing = new Leaf().assign({ value: 1 });
        state.trailing.set("sentinel", trailing);

        const encoder = new Encoder(state);
        const decoder = Reflection.decode<State>(Reflection.encode(encoder));
        decoder.decode(encoder.encodeAll());
        encoder.discardChanges();

        const predecessorNode = state.noise.get("noise-0")[$changes].allChanges.queueRootNode!;
        const trailingNode = trailing[$changes].allChanges.queueRootNode!;
        const trailingPosition = trailingNode.position;
        const removedNodeCount = 2 + actor.children.size;

        let predecessorReads = 0;
        let predecessorNext = predecessorNode.next;
        Object.defineProperty(predecessorNode, "next", {
            configurable: true,
            get() {
                predecessorReads++;
                return predecessorNext;
            },
            set(value: typeof predecessorNext) {
                predecessorNext = value;
            },
        });

        state.actors.delete("departing");

        assert.strictEqual(predecessorReads, 0);
        assert.strictEqual(trailingNode.position, trailingPosition - removedNodeCount);

        trailing.value = 2;
        decoder.decode(encoder.encode());
        assert.strictEqual(decoder.state.actors.has("departing"), false);
        assert.strictEqual(decoder.state.trailing.get("sentinel").value, 2);
    });
});
