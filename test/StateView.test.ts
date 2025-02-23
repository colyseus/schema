import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder, ChangeTree, $changes, OPERATION } from "../src";
import { createClientWithView, encodeMultiple, assertEncodeAllMultiple, getDecoder, getEncoder, createInstanceFromReflection, encodeAllForView, encodeAllMultiple } from "./Schema";
import { getDecoderStateCallbacks } from "../src/decoder/strategy/StateCallbacks";
import { nanoid } from "nanoid";

describe("StateView", () => {

    it("should filter out a property", () => {
        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type("string") prop2 = "Secret info";
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client1 = createClientWithView(state);
        client1.view.add(state);

        const client2 = createClientWithView(state);
        encodeMultiple(encoder, state, [client1, client2]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.prop2, state.prop2);

        assert.strictEqual(client2.state.prop1, state.prop1);
        assert.strictEqual(client2.state.prop2, undefined);

        assertEncodeAllMultiple(encoder, state, [client1, client2])
    });

    it("should allow adding detached instances to the view", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type([Item]) items = new ArraySchema<Item>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client1 = createClientWithView(state);
        client1.view.add(state.items);

        for (let i = 0; i < 5; i++) {
            const item = new Item().assign({ amount: i });
            client1.view.add(item);
            state.items.push(item);
        }

        encodeMultiple(encoder, state, [client1]);

        assert.strictEqual(client1.state.prop1, state.prop1);
        assert.strictEqual(client1.state.items.length, 5);

        assertEncodeAllMultiple(encoder, state, [client1])
    });

    describe("tagged properties", () => {
        it("filter properties by tag", () => {
            enum Tag { ZERO = 0, ONE = 1 };

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

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            client1.view.add(state.players.get("0"));
            client1.view.add(state.players.get("1"), Tag.ZERO);
            client1.view.add(state.players.get("2"), Tag.ONE);
            client1.view.add(state.players.get("3"));
            client1.view.add(state.players.get("4"));

            const client2 = createClientWithView(state);
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

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("view.remove() change should assign property to undefined", () => {
            class Item extends Schema {
                @view() @type("number") amount: number;
            }

            class State extends Schema {
                @type(Item) item = new Item();
            }

            const state = new State();
            state.item = new Item().assign({ amount: 10 });

            const encoder = getEncoder(state);
            const client1 = createClientWithView(state);
            client1.view.add(state.item);

            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(10, client1.state.item.amount);

            // remove item from view
            client1.view.remove(state.item);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(undefined, client1.state.item.amount);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("view.add(TAG) should re-encode a discarded change", () => {
            const FOV_TAG = 1;

            class Item extends Schema {
                @view() @type("number") amount: number;
                @view(FOV_TAG) @type("number") fov: number;
            }

            class State extends Schema {
                @type(Item) item = new Item();
            }

            const state = new State();
            state.item = new Item().assign({
                amount: 10,
                fov: 20
            });

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            client1.view.add(state.item);

            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov);

            // add item to view & encode again
            client1.view.add(state.item, FOV_TAG);
            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(20, client1.state.item.fov);

            // remove item from view
            client1.view.remove(state.item);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(undefined, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("view.add(TAG) should not encode ADD twice", () => {
            enum Tag { ONE = 1, TWO = 2 };

            class Item extends Schema {
                @view() @type("number") amount: number;
                @view(Tag.ONE) @type("number") fov1: number;
                @view(Tag.TWO) @type("number") fov2: number;
            }

            class State extends Schema {
                @type(Item) item = new Item();
            }

            const state = new State();
            state.item = new Item().assign({ amount: 10, });

            const encoder = new Encoder(state);

            const client1 = createClientWithView(state);
            client1.view.add(state.item);

            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov1);
            assert.strictEqual(undefined, client1.state.item.fov2);

            // add item to view & encode again
            client1.view.add(state.item);
            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov1);
            assert.strictEqual(undefined, client1.state.item.fov2);

            state.item.fov1 = 20;
            state.item.fov2 = 30;
            client1.view.add(state.item, Tag.ONE);
            const encodedTag1 = encodeMultiple(encoder, state, [client1])[0];
            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(20, client1.state.item.fov1);
            assert.strictEqual(undefined, client1.state.item.fov2);

            client1.view.add(state.item, Tag.TWO);
            const encodedTag2 = encodeMultiple(encoder, state, [client1])[0];

            // compare encode1 with encode2
            assert.strictEqual(4, Array.from(encodedTag1).length, "should encode only the new field");
            assert.strictEqual(Array.from(encodedTag1).length, Array.from(encodedTag2).length, "encode size should be the same");
            assert.strictEqual(Array.from(encodedTag1)[0], Array.from(encodedTag2)[0]);
            assert.strictEqual(Array.from(encodedTag1)[1], Array.from(encodedTag2)[1]);
            assert.strictEqual(Array.from(encodedTag1)[2] + 1, Array.from(encodedTag2)[2]); // field index (+1 so 1 -> 2)
            assert.strictEqual(Array.from(encodedTag1)[3] + 10, Array.from(encodedTag2)[3]); // value (+ 10 so 20 -> 30)

            assert.strictEqual(10, client1.state.item.amount);
            assert.strictEqual(20, client1.state.item.fov1);
            assert.strictEqual(30, client1.state.item.fov2);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("view.add(TAG) should not encode ADD on top of a previous REMOVE", () => {
            enum Tag { ONE = 1, TWO = 2 };

            class Item extends Schema {
                @view() @type("number") amount: number;
                @view(Tag.ONE) @type("number") fov1: number;
                @view(Tag.TWO) @type("number") fov2: number;
            }

            class State extends Schema {
                @type(Item) item = new Item();
            }

            const state = new State();
            state.item = new Item().assign({
                amount: 10,
                fov1: 20,
                fov2: 30
            });

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(undefined, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov1);
            assert.strictEqual(undefined, client1.state.item.fov2);

            state.item.amount = undefined;
            state.item.fov1 = undefined;
            state.item.fov2 = undefined;

            client1.view.add(state.item);
            client1.view.add(state.item, Tag.ONE);
            client1.view.add(state.item, Tag.TWO);

            console.log(Schema.debugRefIds(state));

            // add item to view & encode again
            const encoded = encodeMultiple(encoder, state, [client1])[0];
            // assert.deepStrictEqual([], Array.from(encoded));

            assert.strictEqual(undefined, client1.state.item.amount);
            assert.strictEqual(undefined, client1.state.item.fov1);
            assert.strictEqual(undefined, client1.state.item.fov2);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("view.add(TAG) with nested types", () => {
            enum Tag { ONE = 1, TWO = 2 };

            class Vec3 extends Schema {
                @type("number") x: number;
                @type("number") y: number;
                @type("number") z: number;
            }

            class Player extends Schema {
                @type("number") pub: number;
                @view() @type("number") priv: number;
                @view(Tag.ONE) @type(Vec3) position: Vec3;
                @view(Tag.TWO) @type("number") tagged: number;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            function addPlayer(i: number) {
                const player = new Player().assign({
                    pub: i,
                    priv: i * 2,
                    position: new Vec3().assign({ x: i * 10, y: i * 10, z: i * 10 }),
                    tagged: i * 3
                });
                state.players.set(i.toString(), player);
                return player;
            }

            const p1 = addPlayer(1);

            const client1 = createClientWithView(state);
            client1.view.add(p1);

            const p2 = addPlayer(2);

            const client2 = createClientWithView(state);
            client2.view.add(p2);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual({ pub: 1, priv: 2 }, client1.state.players.get("1").toJSON());
            assert.deepStrictEqual({ pub: 2 }, client1.state.players.get("2").toJSON());

            assert.deepStrictEqual({ pub: 1 }, client2.state.players.get("1").toJSON());
            assert.deepStrictEqual({ pub: 2, priv: 4 }, client2.state.players.get("2").toJSON());

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });
    });

    describe("MapSchema", () => {
        it("should sync single item from map", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @type("string") prop1 = "Hello world";
                @view() @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            for (let i = 0; i < 5; i++) {
                state.items.set(i.toString(), new Item().assign({ amount: i }));
            }

            client1.view.add(state.items.get("3"));

            const client2 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.prop1, state.prop1);
            assert.strictEqual(client1.state.items.size, 1);
            assert.strictEqual(client1.state.items.get("3").amount, state.items.get("3").amount);

            assert.strictEqual(client2.state.prop1, state.prop1);
            assert.strictEqual(client2.state.items, undefined);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("should allow to add/remove items", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();

            for (let i = 0; i < 10; i++) {
                const item = new Item().assign({ amount: i });
                state.items.set(i.toString(), item);
            }
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            const encoded0 = encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(0, Array.from(encoded0[0]).length);
            assert.strictEqual(0, Array.from(encoded0[1]).length);
            assert.strictEqual(client1.state.items, undefined);
            assert.strictEqual(client2.state.items, undefined);

            client1.view.add(state.items.get("3"));
            client1.view.add(state.items.get("4"));

            client2.view.add(state.items.get("4"));
            client2.view.add(state.items.get("5"));

            // first encode
            const encoded1 = encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(Array.from(encoded1[0]).length, Array.from(encoded1[1]).length);

            assert.strictEqual(client1.state.items.size, 2);
            assert.strictEqual(client1.state.items.get("3").amount, state.items.get("3").amount);
            assert.strictEqual(client1.state.items.get("4").amount, state.items.get("4").amount);

            assert.strictEqual(client2.state.items.size, 2);
            assert.strictEqual(client2.state.items.get("4").amount, state.items.get("4").amount);
            assert.strictEqual(client2.state.items.get("5").amount, state.items.get("5").amount);
            //

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("should hide a single field on child structure", () => {
            class Vec2 extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }

            class Item extends Schema {
                @view() @type(Vec2) position: Vec2;
                @type("number") health: number = 100;
            }

            class State extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            function createItem(i: number) {
                state.items.set(i.toString(), new Item().assign({
                    position: new Vec2().assign({ x: i * 10, y: i * 10 }),
                    health: i * 100
                }));
            }

            createItem(1);
            createItem(2);

            const client1 = createClientWithView(state);
            client1.view.add(state.items.get("1"));

            const client2 = createClientWithView(state);
            client2.view.add(state.items.get("2"));

            encodeMultiple(encoder, state, [client1, client2]);

            // client 1 should have only the position field
            assert.strictEqual(2, client1.state.items.size);
            assert.deepStrictEqual({ x: 10, y: 10 }, client1.state.items.get("1").position.toJSON());
            assert.strictEqual(100, client1.state.items.get("1").health);
            assert.strictEqual(undefined, client1.state.items.get("2").position);
            assert.strictEqual(200, client1.state.items.get("2").health);

            // client 2 should have only the position field
            assert.strictEqual(2, client2.state.items.size);
            assert.strictEqual(undefined, client2.state.items.get("1").position);
            assert.strictEqual(100, client2.state.items.get("1").health);
            assert.deepStrictEqual({ x: 20, y: 20 }, client2.state.items.get("2").position.toJSON());
            assert.strictEqual(200, client2.state.items.get("2").health);

            // create client3 and add new item to his view
            createItem(3);
            const client3 = createClientWithView(state);
            client3.view.add(state.items.get("3"));

            encodeMultiple(encoder, state, [client1, client2, client3]);

            assert.strictEqual(3, client1.state.items.size);
            assert.strictEqual(300, client1.state.items.get("3").health);

            assert.strictEqual(300, client2.state.items.get("3").health);
            assert.strictEqual(3, client2.state.items.size);

            // client 3 should have only the position field
            assert.strictEqual(3, client3.state.items.size);
            assert.deepStrictEqual({ x: 30, y: 30 }, client3.state.items.get("3").position.toJSON());
            assert.strictEqual(undefined, client3.state.items.get("1").position);
            assert.strictEqual(100, client3.state.items.get("1").health);
            assert.strictEqual(undefined, client3.state.items.get("2").position);
            assert.strictEqual(200, client3.state.items.get("2").health);

            // create client4 and add new item to his view
            createItem(4);
            const client4 = createClientWithView(state);
            client4.view.add(state.items.get("4"));

            encodeMultiple(encoder, state, [client1, client2, client3, client4]);
            assertEncodeAllMultiple(encoder, state, [client1, client2, client3, client4])
        });

        it("should allow later add of whole structure", () => {
            class Component extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }

            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
                @type([Component]) components = new ArraySchema<Component>();
            }

            class MyRoomState extends Schema {
                @view() @type({ map: Entity }) entities = new Map<string, Entity>();
            }

            function createEntity() {
                const entity = new Entity();
                entity.components.push(new Component().assign({ name: "Health", value: 100 }));
                return entity;
            }

            const state = new MyRoomState();
            const encoder = getEncoder(state);

            const entity = createEntity();
            state.entities.set(entity.id, entity);

            for (let i = 0; i < 1; i++) {
                const entity = createEntity();
                state.entities.set(entity.id, entity);
              }

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            assert.doesNotThrow(() => {
                encodeMultiple(encoder, state, [client1, client2]);
            });

            client1.view.add(state.entities.get(entity.id));

            assert.doesNotThrow(() => {
                encodeMultiple(encoder, state, [client1, client2]);
            });

            assert.strictEqual(1, client1.state.entities.size);
            assert.deepStrictEqual(entity.toJSON(), client1.state.entities.get(entity.id).toJSON());

            assert.strictEqual(undefined, client2.state.entities);
        });
    });

    describe("ArraySchema", () => {
        it("should allow both filtered and unfiltered arrays", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @type([Item]) unfilteredItems = new ArraySchema<Item>();
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            for (let i = 0; i < 3; i++) {
                state.items.push(new Item().assign({ amount: i }));
                state.unfilteredItems.push(new Item().assign({ amount: i }));
            }

            client2.view.add(state.items);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.unfilteredItems.at(0).amount, state.unfilteredItems.at(0).amount);
            assert.strictEqual(client1.state.unfilteredItems.at(1).amount, state.unfilteredItems.at(1).amount);
            assert.strictEqual(client1.state.unfilteredItems.at(2).amount, state.unfilteredItems.at(2).amount);

            assert.strictEqual(client1.state.items, undefined);
            assert.strictEqual(client1.state.unfilteredItems.length, 3);

            assert.strictEqual(client2.state.items.at(0).amount, state.items.at(0).amount);
            assert.strictEqual(client2.state.items.at(1).amount, state.items.at(1).amount);
            assert.strictEqual(client2.state.items.at(2).amount, state.items.at(2).amount);

            assert.strictEqual(client2.state.unfilteredItems.at(0).amount, state.unfilteredItems.at(0).amount);
            assert.strictEqual(client2.state.unfilteredItems.at(1).amount, state.unfilteredItems.at(1).amount);
            assert.strictEqual(client2.state.unfilteredItems.at(2).amount, state.unfilteredItems.at(2).amount);

            assert.strictEqual(client2.state.items.length, 3);
            assert.strictEqual(client2.state.unfilteredItems.length, 3);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("should allow to add ArraySchema with its contents", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @type("string") prop1 = "Hello world";
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            for (let i = 0; i < 5; i++) {
                state.items.push(new Item().assign({ amount: i }));
            }

            client1.view.add(state.items);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.prop1, state.prop1);
            assert.strictEqual(client1.state.items.length, 5);

            assertEncodeAllMultiple(encoder, state, [client1])
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
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            for (let i = 0; i < 5; i++) {
                const item = new Item().assign({ amount: i });
                state.items.push(item);
                client1.view.add(item);
            }

            const client2 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.prop1, state.prop1);
            assert.strictEqual(client1.state.items.length, 5);

            assert.strictEqual(client2.state.prop1, state.prop1);
            assert.strictEqual(client2.state.items, undefined);

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("should sync single item of array", () => {
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

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            client1.view.add(state.items.at(3));

            const client2 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.prop1, state.prop1);
            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client1.state.items[0].amount, state.items.at(3).amount);

            assert.strictEqual(client2.state.prop1, state.prop1);
            assert.strictEqual(client2.state.items, undefined);

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("should splice correct item", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            for (let i = 0; i < 5; i++) {
                state.items.push(new Item().assign({ amount: i + 2 }));
            }

            const encoder = getEncoder(state);

            // client1 has only one item
            const client1 = createClientWithView(state);
            client1.view.add(state.items.at(3));

            // client2 has all items
            const client2 = createClientWithView(state);
            client2.view.add(state.items);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client1.state.items[0].amount, state.items.at(3).amount);
            assert.deepStrictEqual(client2.state.items.toJSON(), state.items.toJSON());

            const removedItems = state.items.splice(3, 1);

            assert.strictEqual(1, removedItems.length);
            assert.strictEqual(5, removedItems[0].amount);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.items.length, 0);
            assert.deepStrictEqual(client2.state.items.toJSON(), state.items.toJSON());

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("visibility change should add/remove array items", () => {
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

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            client1.view.add(state.items.at(3));

            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client1.state.items[0].amount, state.items[3].amount);

            // remove item from view
            client1.view.remove(state.items.at(3));

            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.length, 0);

            assertEncodeAllMultiple(encoder, state, [client1])
        });

        it("visibility change should trigger onAdd/onRemove on arrays", () => {
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

            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            client1.view.add(state.items.at(3));
            client2.view.add(state.items);

            let onAddCalls = 0;
            let onRemoveCalls = 0;

            client1.$(client1.state).items.onAdd(() => onAddCalls++);
            client1.$(client1.state).items.onRemove(() => onRemoveCalls++);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.items.length, 1);
            assert.strictEqual(client2.state.items.length, 5);
            assert.strictEqual(1, onAddCalls);

            client1.view.remove(state.items.at(3));
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.items.length, 0);
            assert.strictEqual(client2.state.items.length, 5);
            assert.strictEqual(1, onRemoveCalls);

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        });

        it("replacing collection of items while keeping a reference to an item", () => {
            class Song extends Schema {
                @type("string") url: string;
            }

            class Player extends Schema {
                @type([Song]) queue = new ArraySchema<Song>();
            }

            class State extends Schema {
                @type(Song) playing: Song = new Song();
                @view() @type([Song]) queue = new ArraySchema<Song>();
                @type({ map: Player }) buckets = new MapSchema<Player>();
            }

            const sessionId = "session1";

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            encodeMultiple(encoder, state, [client1]);

            state.buckets.set(sessionId, new Player());

            encodeMultiple(encoder, state, [client1]);
            console.log(Schema.debugRefIds(state));

            const newSong = new Song().assign({ url: "song2" });
            state.buckets.get(sessionId).queue.push(newSong);

            state.queue = new ArraySchema<Song>();
            state.queue.push(newSong);

            state.playing = state.buckets.get(sessionId).queue.shift();
            state.queue = new ArraySchema<Song>();

            encodeMultiple(encoder, state, [client1]);

            assert.doesNotThrow(() =>
                encodeAllMultiple(encoder, state, [client1]));
        });

        it("setting a non-view field to undefined should not interfere on encoding", () => {
            class Song extends Schema {
                @type("string") url: string;
            }

            class State extends Schema {
                @type(Song) playing: Song = new Song();
                @view() @type([Song]) queue = new ArraySchema<Song>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            state.playing = undefined;
            encodeMultiple(encoder, state, [client1]);

            assert.doesNotThrow(() =>
                encodeAllMultiple(encoder, state, [client1]));
        });
    });

    describe("checkIsFiltered", () => {
        /**
         * prepare a schema with a filtered property
         */
        class Component extends Schema {
            @type("string") name: string;
            @type("number") value: number;
        }

        class ListComponent extends Component {
            @type(["string"]) list = new ArraySchema<string>();
        }

        class TagComponent extends Component {
            @type("string") tag: string;
        }

        class Entity extends Schema {
            @type("string") id: string = nanoid(9);
            @type([Component]) components = new ArraySchema<Component>();
            @type(Component) component;
        }

        class MyRoomState extends Schema {
            @view() @type({ map: Entity }) entities = new Map<string, Entity>();
            @type(Component) component;
        }

        it("2nd level of @view() should be identified as 'filtered'", () => {
            const state = new MyRoomState();
            const encoder = getEncoder(state);

            const contextDebug = encoder.context.debug();

            assert.strictEqual(false, state[$changes].isFiltered);
            assert.strictEqual(true, state[$changes].filteredChanges !== undefined);

            const entity = new Entity();
            state.entities.set("1", entity);

            entity.components.push(new Component());
            assert.strictEqual(entity.components[0][$changes].isFiltered, true);

            entity.components.push(new TagComponent());
            assert.strictEqual(entity.components[1][$changes].isFiltered, true);

            entity.components.push(new ListComponent().assign({list: new ArraySchema("one", "two")}));
            assert.strictEqual(entity.components[2][$changes].isFiltered, true);

            entity.component = new Component();
            assert.strictEqual(true, entity.component[$changes].isFiltered);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(contextDebug, `TypeContext ->
	Schema types: 5
	hasFilters: true
	parentFiltered:
		1-0-0: MyRoomState[entities] -> Entity
		2-1-1: Entity[components] -> Component
		3-1-1: Entity[components] -> ListComponent
		4-1-1: Entity[components] -> TagComponent
		2-1-2: Entity[component] -> Component`);


        });

    });

});
