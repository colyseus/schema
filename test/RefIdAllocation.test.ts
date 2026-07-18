import * as assert from "assert";
import { MapSchema, Schema, type } from "../src";
import { $refId } from "../src/types/symbols";
import { getEncoder, createInstanceFromReflection } from "./Schema";

class Entity extends Schema {
    @type("string") name: string = "";
    @type("number") x: number = 0;
}

class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

describe("RefId allocation", () => {
    it("allocates refIds monotonically — churn never shrinks or reuses ids", () => {
        const state = new State();
        const encoder = getEncoder(state);
        const decoded = createInstanceFromReflection(state);

        decoded.decode(state.encode());
        const baselineNextId = (encoder.root as any).nextUniqueId;

        const ticks = 50;
        for (let i = 0; i < ticks; i++) {
            state.entities.set("e", new Entity().assign({ name: "e" + i }));
            decoded.decode(state.encode());
            state.entities.delete("e");
            decoded.decode(state.encode());
        }

        const nextId = (encoder.root as any).nextUniqueId;

        // one fresh refId per churned Entity — freed ids are never recycled,
        // so a refId is a stable identity for the lifetime of the room
        // (clients that miss DELETEs can never see an id rebound).
        assert.strictEqual(nextId - baselineNextId, ticks);

        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
    });

    it("never hands a freed refId to a new instance", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        decoded.decode(state.encode());

        const first = new Entity().assign({ name: "first" });
        state.entities.set("a", first);
        decoded.decode(state.encode());
        const freedRefId = (first as any)[$refId];

        state.entities.delete("a");
        decoded.decode(state.encode());

        for (let i = 0; i < 5; i++) {
            const e = new Entity().assign({ name: "e" + i });
            state.entities.set("e" + i, e);
            decoded.decode(state.encode());
            assert.ok(
                (e as any)[$refId] > freedRefId,
                `expected fresh refId > ${freedRefId}, got ${(e as any)[$refId]}`
            );
        }
    });

    it("decodes correctly on delete-then-add across ticks", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        decoded.decode(state.encode());

        state.entities.set("a", new Entity().assign({ name: "first", x: 1 }));
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("a")!.name, "first");

        state.entities.delete("a");
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("a"), undefined);

        state.entities.set("b", new Entity().assign({ name: "second", x: 2 }));
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.get("b")!.name, "second");
        assert.strictEqual(decoded.entities.get("b")!.x, 2);
    });

    it("handles same-tick delete+add without collision", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        decoded.decode(state.encode());

        state.entities.set("a", new Entity().assign({ name: "first" }));
        decoded.decode(state.encode());

        state.entities.delete("a");
        state.entities.set("b", new Entity().assign({ name: "second" }));
        decoded.decode(state.encode());

        assert.strictEqual(decoded.entities.get("a"), undefined);
        assert.strictEqual(decoded.entities.get("b")!.name, "second");
    });
});
