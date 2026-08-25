import * as assert from "assert";
import { Schema, MapSchema, StateView, schema, t, SchemaType } from "../src";
import {
    createClientWithView,
    encodeMultiple,
    getEncoder,
} from "./Schema";

describe("Streamable MapSchema (t.map(X).stream())", () => {

    it("maxPerTick caps broadcast ADDs per shared tick", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const State = schema({ entities: t.map(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const decoded: SchemaType<typeof State> = new State();
        decoded.decode(state.encodeAll());

        for (let i = 0; i < 5; i++) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = i;
            state.entities.set(`e${i}`, e);
        }

        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 2);

        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 4);

        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 5);
    });

    it("priority sort per StateView", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        // Builder form: `.stream().priority((view, el) => ...)`. Prioritizes
        // higher-id entities first.
        const State = schema({
            entities: t.map(Entity).stream()
                .priority((_view: any, el: SchemaType<typeof Entity>) => el.id),
        }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const ids = [1, 50, 10, 99];
        for (const id of ids) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = id;
            state.entities.set(`e${id}`, e);
            client.view.add(e);
        }

        encodeMultiple(encoder, state, [client]);

        const decodedIds: number[] = [];
        client.state.entities.forEach((v) => decodedIds.push(v.id));
        decodedIds.sort((a, b) => a - b);
        assert.deepStrictEqual(decodedIds, [50, 99]);
    });

    it("delete() before sent drops silently; after sent emits DELETE", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const State = schema({ entities: t.map(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 1;
        const encoder = getEncoder(state);

        const decoded: SchemaType<typeof State> = new State();
        decoded.decode(state.encodeAll());

        const e1: SchemaType<typeof Entity> = new Entity();
        e1.id = 1;
        state.entities.set("e1", e1);

        const e2: SchemaType<typeof Entity> = new Entity();
        e2.id = 2;
        state.entities.set("e2", e2);

        // e2 was pending but never emitted — silent drop.
        state.entities.delete("e2");

        decoded.decode(state.encode());
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 1);
        assert.strictEqual(decoded.entities.get("e1")?.id, 1);

        // Now remove e1 after it was emitted → DELETE on the wire next tick.
        state.entities.delete("e1");
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 0);
    });

    it("late-joining view explicitly subscribes to existing entries", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const State = schema({ entities: t.map(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        // Stream was populated in view mode (placeholder view keeps
        // `activeViews.size > 0` so stream.set doesn't seed broadcast).
        const placeholder = new StateView();
        placeholder.add(state);
        for (let i = 0; i < 4; i++) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = i;
            state.entities.set(`e${i}`, e);
        }
        encoder.discardChanges();
        placeholder.dispose();

        const client = createClientWithView(state);
        client.view.add(state);
        // Game-loop responsibility: bulk-subscribe.
        state.entities.forEach((e) => client.view.add(e));

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.size, 2);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.size, 4);
    });

});
