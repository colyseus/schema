import * as assert from "assert";
import { MapSchema, Schema, type } from "../src";
import { getEncoder, createInstanceFromReflection } from "./Schema";

class Entity extends Schema {
    @type("string") name: string = "";
    @type("number") x: number = 0;
}

class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

describe("RefId pool", () => {
    it("recycles refIds across ticks so long-running churn stays bounded", () => {
        const state = new State();
        const encoder = getEncoder(state);
        const decoded = createInstanceFromReflection(state);

        decoded.decode(state.encode());
        const baselineNextId = (encoder.root.refIds as any).nextUniqueId;

        const ticks = 50;
        for (let i = 0; i < ticks; i++) {
            state.entities.set("e", new Entity().assign({ name: "e" + i }));
            decoded.decode(state.encode());
            state.entities.delete("e");
            decoded.decode(state.encode());
        }

        const nextId = (encoder.root.refIds as any).nextUniqueId;

        // without pooling, nextUniqueId would grow by ~ticks. With pooling,
        // the same freed refId is reclaimed each cycle, so growth is small.
        assert.ok(
            nextId - baselineNextId <= 4,
            `expected nextUniqueId growth <= 4, got ${nextId - baselineNextId}`
        );

        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
    });

    it("decodes correctly when a refId is reused across ticks (DELETE -> ADD)", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        decoded.decode(state.encode());

        state.entities.set("a", new Entity().assign({ name: "first", x: 1 }));
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("a")!.name, "first");

        state.entities.delete("a");
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("a"), undefined);

        // tick 3: add a fresh entity. It should pop the reused refId from
        // the pool. Decoder must produce the new state, not the stale one.
        state.entities.set("b", new Entity().assign({ name: "second", x: 2 }));
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("b")!.name, "second");
        assert.strictEqual(decoded.entities.get("b")!.x, 2);
    });

    it("handles same-tick delete+add without collision (no pool reuse within tick)", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        decoded.decode(state.encode());

        state.entities.set("a", new Entity().assign({ name: "first" }));
        decoded.decode(state.encode());

        // same-tick churn: delete then add a fresh instance. Within a
        // single tick, the pool is NOT flushed — the new instance must
        // get a fresh refId, not the just-freed one, so wire ordering
        // stays unambiguous.
        state.entities.delete("a");
        state.entities.set("b", new Entity().assign({ name: "second" }));
        decoded.decode(state.encode());

        assert.strictEqual(decoded.entities.get("a"), undefined);
        assert.strictEqual(decoded.entities.get("b")!.name, "second");
    });
});
