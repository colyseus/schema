import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder, Decoder, } from "../src";
import { createInstanceFromReflection } from "./Schema";

interface ClientView {
    state: Schema;
    view: StateView;
}

function createClient<T extends Schema>(from: T) {
    return {
        state: createInstanceFromReflection(from),
        view: new StateView()
    };
}

function encodeMultiple<T extends Schema>(encoder: Encoder<T>, state: T, clients: ClientView[]) {
    const it = { offset: 0 };

    // perform shared encode
    console.log("> SHARED ENCODE...")
    encoder.encode(it);
    console.log("< SHARED ENCODE FINISHED...")

    const sharedOffset = it.offset;
    clients.forEach(client => {
        if (!client.state) {
            client.state = createInstanceFromReflection(state);
        }

        // encode each view
        console.log("> ENCODE VIEW...");
        const encoded = encoder.encodeView(client.view, sharedOffset, it);
        console.log("< ENCODE VIEW FINISHED...");

        console.log("> DECODE VIEW...");
        client.state.decode(encoded);
        console.log("< DECODE VIEW FINISHED...");
    });
}

describe("StateView", () => {

    class Vec3 extends Schema {
        @type("number") x: number;
        @type("number") y: number;
        @type("number") z: number;
    }

    class Entity extends Schema {
        @type(Vec3) position = new Vec3().assign({ x: 0, y: 0, z: 0 });
    }

    class Card extends Schema {
        @type("string") suit: string;
        @type("number") num: number;
    }

    class Player extends Entity {
        @type(Vec3) rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
        @type("string") secret: string = "private info only for this player";
        @type([Card]) cards = new ArraySchema<Card>(
            new Card().assign({ suit: "Hearts", num: 1 }),
            new Card().assign({ suit: "Spaces", num: 2 }),
            new Card().assign({ suit: "Diamonds", num: 3 }),
        );
    }

    class Team extends Schema {
        @type({ map: Entity }) entities = new MapSchema<Entity>();
    }

    class State extends Schema {
        @type("number") num: number = 0;
        @type("string") str = "Hello world!"
        @view() @type([Team]) teams = new ArraySchema<Team>();
    }

    it("should filter out a property", () => {
        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type("string") prop2 = "Secret info";
        }

        const state = new State();
        const encoder = new Encoder(state);

        const client1 = createClient(state);
        client1.view.add(state);

        const client2 = createClient(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.prop2, state.prop2);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.prop2, undefined);
    });

    it("should filter items inside a collection", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type([Item]) items = new ArraySchema<Item>();
        }

        const state = new State();
        for (let i=0;i<5;i++) {
            state.items.push(new Item().assign({ amount: i }));
        }

        const encoder = new Encoder(state);

        const client1 = createClient(state);
        client1.view.add(state.items);

        const client2 = createClient(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.items.length, 5);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.items, undefined);
    });

    it("MapSchema: should sync single item", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type({ map: Item }) items = new MapSchema<Item>();
        }

        const state = new State();
        for (let i=0;i<5;i++) {
            state.items.set(i.toString(), new Item().assign({ amount: i }));
        }

        const encoder = new Encoder(state);

        const client1 = createClient(state);
        client1.view.add(state.items.get("3"));

        const client2 = createClient(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.items.size, 1);
        assert.strictEqual(client1.state.items.get("3").amount, state.items.get("3").amount);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.items, undefined);
    });

    it("ArraySchema: should sync single item", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type([Item]) items = new ArraySchema<Item>();
        }

        const state = new State();
        for (let i=0;i<5;i++) {
            state.items.push(new Item().assign({ amount: i }));
        }

        const encoder = new Encoder(state);

        const client1 = createClient(state);
        client1.view.add(state.items.at(3));

        const client2 = createClient(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.items.length, 1);
        assert.strictEqual(client1.state.items[0].amount, state.items.at(3).amount);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.items, undefined);
    });

})