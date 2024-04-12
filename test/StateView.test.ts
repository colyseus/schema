import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder } from "../src";
import { createInstanceFromReflection, getDecoder } from "./Schema";
import { getStateCallbacks } from "../src/decoder/strategy/StateCallbacks";

interface ClientView {
    state: Schema;
    view: StateView;
}

function createClient<T extends Schema>(from: T) {
    const state = createInstanceFromReflection(from);
    return {
        state,
        view: new StateView(),
        $: getStateCallbacks(getDecoder(state)).$
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
        client1.view.add(state.players.get("0"));
        client1.view.add(state.players.get("1"), Tag.ZERO);
        client1.view.add(state.players.get("2"), Tag.ONE);
        client1.view.add(state.players.get("3"));
        client1.view.add(state.players.get("4"));

        const client2 = createClient(state);
        client2.view.add(state.players.get("0"));

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
        assert.strictEqual(client2.state.players.get("0").tag_default, state.players.get("0").tag_default);
        for (let i = 0; i < 5; i++) {
            if (i !== 0) {
                assert.strictEqual(client2.state.players.get(i.toString()).tag_default, undefined);
            }
            assert.strictEqual(client2.state.players.get(i.toString()).tag_0, undefined);
            assert.strictEqual(client2.state.players.get(i.toString()).tag_1, undefined);
        }
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
            for (let i = 0; i < 5; i++) {
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

        it("visibility change should add/remove item", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            for (let i = 0; i < 5; i++) {
                state.items.push(new Item().assign({ amount: i }));
            }

            const encoder = new Encoder(state);

            const client1 = createClient(state);
            client1.view.add(state.items.at(3));

            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client1.state.items[0].amount, state.items[3].amount);

            // remove item from view
            client1.view.remove(state.items.at(3));
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.length, 0);
        });

        xit("visibility change should trigger onAdd/onRemove", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            for (let i = 0; i < 5; i++) {
                state.items.push(new Item().assign({ amount: i }));
            }

            const encoder = new Encoder(state);

            const client1 = createClient(state);
            client1.view.add(state.items.at(3));

            let onAddCalls = 0;
            client1.$(client1.state).items.onAdd((item, index) => onAddCalls++);
            let onRemoveCalls = 0;
            client1.$(client1.state).items.onRemove((item, index) => onRemoveCalls++);

            const client2 = createClient(state);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client2.state.items, undefined);
        });
    });

});