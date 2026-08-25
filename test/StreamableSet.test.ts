import * as assert from "assert";
import { Schema, SetSchema, StateView, schema, t, SchemaType } from "../src";
import {
    createClientWithView,
    encodeMultiple,
    getEncoder,
} from "./Schema";

describe("Streamable SetSchema (t.set(X).stream())", () => {

    it("maxPerTick caps broadcast ADDs per shared tick", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const State = schema({ entities: t.set(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const decoded: SchemaType<typeof State> = new State();
        decoded.decode(state.encodeAll());

        for (let i = 0; i < 5; i++) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = i;
            state.entities.add(e);
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
        const State = schema({
            entities: t.set(Entity).stream()
                .priority((_view: any, el: SchemaType<typeof Entity>) => el.id),
        }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const ids = [1, 50, 10, 99];
        const entities: SchemaType<typeof Entity>[] = [];
        for (const id of ids) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = id;
            state.entities.add(e);
            entities.push(e);
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
        const State = schema({ entities: t.set(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 1;
        const encoder = getEncoder(state);

        const decoded: SchemaType<typeof State> = new State();
        decoded.decode(state.encodeAll());

        const e1: SchemaType<typeof Entity> = new Entity(); e1.id = 1;
        const e2: SchemaType<typeof Entity> = new Entity(); e2.id = 2;
        state.entities.add(e1);
        state.entities.add(e2);

        // e2 is in broadcast pending but never emitted — silent drop.
        state.entities.delete(e2);

        decoded.decode(state.encode());
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 1);

        // Now remove e1 after it was emitted → DELETE on the wire.
        state.entities.delete(e1);
        decoded.decode(state.encode());
        assert.strictEqual(decoded.entities.size, 0);
    });

    it("subscribe bootstraps existing entries", () => {
        const Entity = schema({ id: t.number() }, "Entity");
        const State = schema({ entities: t.set(Entity).stream() }, "State");

        const state: SchemaType<typeof State> = new State();
        state.entities.maxPerTick = 100;
        const encoder = getEncoder(state);

        // Put the stream into view mode before populating so it doesn't
        // seed broadcast pending.
        const placeholder = new StateView();
        placeholder.add(state);
        for (let i = 0; i < 4; i++) {
            const e: SchemaType<typeof Entity> = new Entity();
            e.id = i;
            state.entities.add(e);
        }
        encoder.discardChanges();
        placeholder.dispose();

        const client = createClientWithView(state);
        client.view.add(state);
        client.view.subscribe(state.entities);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.size, 4);
    });

});
