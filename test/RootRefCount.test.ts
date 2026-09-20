import * as assert from "assert";
import { Schema, type, MapSchema, ArraySchema, $refId, $changes } from "../src";
import { getEncoder, getDecoder } from "./Schema";

describe("Root.refCount", () => {
    class Position extends Schema {
        @type("number") x: number;
        @type("number") y: number;
    }
    class Entity extends Schema {
        @type("string") name: string;
        @type(Position) position = new Position();
        @type(["number"]) scores = new ArraySchema<number>();
    }
    class State extends Schema {
        @type({ map: Entity }) entities = new MapSchema<Entity>();
        @type(Entity) featured: Entity;
    }

    const make = (i: number) => {
        const e = new Entity();
        e.name = `e${i}`;
        e.position.x = i;
        e.scores.push(i);
        return e;
    };

    it("keeps no entry for removed refIds: the tables stay bounded under churn", () => {
        const state = new State();
        const encoder = getEncoder(state);
        const decoded = new State();
        decoded.decode(state.encodeAll());

        for (let i = 0; i < 10; i++) state.entities.set(`k${i}`, make(i));
        decoded.decode(state.encode());
        const baseline = encoder.root.refCount.size;
        assert.strictEqual(baseline, encoder.root.changeTrees.size);

        // 200 cycles, each replacing 5 entities (3 refs each): 3000 refIds allocated and released
        let next = 10;
        for (let cycle = 0; cycle < 200; cycle++) {
            for (let k = 0; k < 5; k++) {
                const key = `k${(cycle * 5 + k) % 10}`;
                state.entities.delete(key);
                state.entities.set(key, make(next++));
            }
            decoded.decode(state.encode());
        }

        assert.strictEqual(encoder.root.refCount.size, baseline, "refCount holds attached trees only");
        assert.strictEqual(encoder.root.changeTrees.size, baseline);
        assert.strictEqual(getDecoder(decoded).root.refs.size, baseline, "decoder agrees on the live set");
        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
    });

    it("re-adding a removed instance re-emits it under the same refId", () => {
        const state = new State();
        const encoder = getEncoder(state);
        const decoded = new State();
        decoded.decode(state.encodeAll());

        const hero = make(1);
        state.entities.set("hero", hero);
        decoded.decode(state.encode());
        const refId = (hero as any)[$refId];
        assert.strictEqual(encoder.root.refCount.get(refId), 1);

        state.entities.delete("hero");
        decoded.decode(state.encode());
        assert.strictEqual(encoder.root.refCount.get(refId), undefined);
        assert.strictEqual((hero as any)[$changes].needsRestage, true, "removal arms the re-stage");
        assert.strictEqual(decoded.entities.size, 0);

        hero.position.x = 42; // mutated while detached
        state.entities.set("again", hero);
        decoded.decode(state.encode());

        assert.strictEqual((hero as any)[$refId], refId, "identity is stable");
        assert.strictEqual(encoder.root.refCount.get(refId), 1);
        assert.strictEqual((hero as any)[$changes].needsRestage, false);
        assert.deepStrictEqual(decoded.toJSON(), state.toJSON(), "every retained field reached the client again");
        assert.strictEqual(decoded.entities.get("again").position.x, 42);
    });

    it("counts shared parent edges and drops the entry with the last one", () => {
        const state = new State();
        const encoder = getEncoder(state);
        const decoded = new State();
        decoded.decode(state.encodeAll());

        const shared = make(7);
        state.entities.set("a", shared);
        state.featured = shared;
        decoded.decode(state.encode());
        const refId = (shared as any)[$refId];
        assert.strictEqual(encoder.root.refCount.get(refId), 2);

        state.featured = undefined;
        decoded.decode(state.encode());
        assert.strictEqual(encoder.root.refCount.get(refId), 1);
        assert.strictEqual(decoded.entities.get("a").name, "e7");

        state.entities.delete("a");
        decoded.decode(state.encode());
        assert.strictEqual(encoder.root.refCount.get(refId), undefined);
        assert.strictEqual(encoder.root.changeTrees.get(refId), undefined);

        // removing again (already detached) is a no-op, not a negative / NaN count
        encoder.root.remove((shared as any)[$changes]);
        assert.strictEqual(encoder.root.refCount.get(refId), undefined);
        assert.strictEqual(encoder.root.refCount.size, encoder.root.changeTrees.size);
    });
});
