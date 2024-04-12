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

    // console.log("> SHARED ENCODE...")
    encoder.encode(it);
    // console.log("< SHARED ENCODE FINISHED...")

    const sharedOffset = it.offset;
    clients.forEach((client, i) => {
        if (!client.state) {
            client.state = createInstanceFromReflection(state);
        }

        // encode each view

        // console.log(`> ENCODE VIEW (${i})...`);
        const encoded = encoder.encodeView(client.view, sharedOffset, it);
        // console.log(`< ENCODE VIEW (${i}) FINISHED...`);

        // console.log("> DECODE VIEW...");
        client.state.decode(encoded);
        // console.log("< DECODE VIEW FINISHED...");
    });
}

describe("StateView", () => {

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
        for (let i = 0; i < 5; i++) {
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

    it("tagged properties", () => {
        enum Tag {
            ZERO = 0,
            ONE = 1
        };

        class Player extends Schema {
            @view()
            @type("number") tag_default: number;

            @view(Tag.ZERO)
            @type("number") tag_0: number;

            @view(Tag.ONE)
            @type("number") tag_1: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        for (let i = 0; i < 5; i++) {
            state.players.set(i.toString(), new Player().assign({
                tag_default: i,
                tag_0: i * 2,
                tag_1: i * 3
            }));
        }

        const encoder = new Encoder(state);

        const client1 = createClient(state);
        client1.view.add(state.players);
        client1.view.add(state.players.get("1"), Tag.ZERO);
        client1.view.add(state.players.get("2"), Tag.ONE);

        const client2 = createClient(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.players.get("0").tag_default, state.players.get("0").tag_default);
        assert.strictEqual(client1.state.players.get("0").tag_0, undefined);
        assert.strictEqual(client1.state.players.get("0").tag_1, undefined);

        assert.strictEqual(client1.state.players.get("1").tag_default, state.players.get("1").tag_default);
        assert.strictEqual(client1.state.players.get("1").tag_0, state.players.get("1").tag_0);
        assert.strictEqual(client1.state.players.get("1").tag_1, undefined);

        assert.strictEqual(client1.state.players.get("2").tag_default, state.players.get("2").tag_default);
        assert.strictEqual(client1.state.players.get("2").tag_0, undefined);
        assert.strictEqual(client1.state.players.get("2").tag_1, state.players.get("2").tag_1);
        assert.strictEqual(client1.state.players.size, 5);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.players.size, 5);
    });

    describe("MapSchema", () => {
        it("should sync single item", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @type("string") prop1 = "Hello world";
                @view() @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            for (let i = 0; i < 5; i++) {
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

    });

    describe("ArraySchema", () => {
        it("should sync single item", () => {
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
    });

});