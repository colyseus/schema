import * as assert from "assert";
import * as util from "util";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder, ChangeTree, $changes, OPERATION, SetSchema, CollectionSchema } from "../src";
import { createClientWithView, encodeMultiple, assertEncodeAllMultiple, getDecoder, getEncoder, createInstanceFromReflection, encodeAllForView, encodeAllMultiple, assertRefIdCounts, InheritanceRoot, Position } from "./Schema";
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

    it("should not be required to add parent structure", () => {
        /**
         * TODO/FIXME: this test is asserting to throw an error, but it should
         * actually work instead.
         */

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

        const item = new Item().assign({ amount: 0 });
        assert.throws(() => {
            client1.view.add(item);
        }, /Make sure to assign the "Item" instance to the state before calling view.add/);

        // state.items.push(item);
        // encodeMultiple(encoder, state, [client1]);
        // assert.strictEqual(client1.state.items.length, 1);
        // assertEncodeAllMultiple(encoder, state, [client1])
    });

    xit("should allow adding detached instances to the view (not immediately attached)", () => {
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

    xit("shouldn't allow to add detached instance to view", () => {
        class Entity extends Schema {
            @type("string") id: string = nanoid(9);
        }
        class State extends Schema {
            @view() @type({ map: Entity }) entities = new MapSchema<Entity>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client1 = createClientWithView(state);
        const client2 = createClientWithView(state);

        encodeMultiple(encoder, state, [client1, client2]);

        const entity1 = new Entity().assign({ id: "one" });
        state.entities.set("one", entity1);

        client1.view.add(entity1);
        encodeMultiple(encoder, state, [client1, client2]);

        const entity2 = new Entity().assign({id: "two"});
        state.entities.set("one", entity2);

        client1.view.add(entity2);

        client2.view.add(entity2);
        client2.view.add(entity1); // adding detached instance, should ignore and not throw an error

        encodeMultiple(encoder, state, [client1, client2]);
        assertEncodeAllMultiple(encoder, state, [client1, client2])
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

        it("adding a property to view should NOT expose all root-level @view() properties", () => {
            class Player extends Schema {
                @view() @type("string") role: string;
            }

            class State extends Schema {
                @type(Player) player = new Player();
                @view() @type("string") privateInfo: string = "I'm private";
            }

            const state = new State();
            state.player.role = "Wizzard";

            const encoder = getEncoder(state);
            const client = createClientWithView(state);

            //
            // TODO: should we have a clearer API to skip adding the parent structure?
            // See: https://github.com/colyseus/schema/pull/194#issuecomment-2776391297
            //
            client.view.add(state.player, -1, false);

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.player.role, "Wizzard");
            assert.strictEqual(client.state.privateInfo, undefined);
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

            // TODO: can we reduce the amount of bytes here?
            // assert.strictEqual(4, Array.from(encodedTag1).length, "should encode only the new field");

            // compare encode1 with encode2
            assert.strictEqual(8, Array.from(encodedTag1).length, "should encode only the new field");
            assert.strictEqual(Array.from(encodedTag1).length, Array.from(encodedTag2).length, "encode size should be the same");
            assert.strictEqual(Array.from(encodedTag1)[0], Array.from(encodedTag2)[0]);
            assert.strictEqual(Array.from(encodedTag1)[1], Array.from(encodedTag2)[1]);
            assert.strictEqual(Array.from(encodedTag1)[2], Array.from(encodedTag2)[2]);
            assert.strictEqual(Array.from(encodedTag1)[3], Array.from(encodedTag2)[3]);

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

        it("having parent @view() container: should include tagged fields", () => {
            class Player extends Schema {
                @type("number") pub: number;
                @view() @type("number") priv: number;
                @view(1) @type("number") tagged: number;
            }

            class State extends Schema {
                @view() @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            function addPlayer(i: number) {
                const player = new Player().assign({
                    pub: i,
                    priv: i * 2,
                    tagged: i * 3
                });
                state.players.set(i.toString(), player);
                return player;
            }

            const player1 = addPlayer(1);

            const client = createClientWithView(state);
            client.view.add(player1, 1);

            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual({ pub: 1, priv: 2, tagged: 3 }, client.state.players.get("1").toJSON());

            assertEncodeAllMultiple(encoder, state, [client])

            // re-use view from client1
            const client2 = createClientWithView(state, client.view);
            encodeMultiple(encoder, state, [client2]);
            assert.deepStrictEqual({ pub: 1, priv: 2, tagged: 3 }, client2.state.players.get("1").toJSON());
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
                @view(1) @type("string") secret = "Secret info";
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
            assert.strictEqual(client1.state.secret, undefined);

            assert.strictEqual(client2.state.prop1, state.prop1);
            assert.strictEqual(client2.state.items, undefined);
            assert.strictEqual(client2.state.secret, undefined);
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

            assertEncodeAllMultiple(encoder, state, [client1, client2])

            // removing items...
            state.items.delete("2"); // none of the clients have this item
            state.items.delete("4"); // shared item between client1 and client2
            state.items.delete("6"); // none of the clients have this item
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(undefined, client1.state.items.get("4"));
            assert.strictEqual(undefined, client2.state.items.get("4"));

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

        it("removing a single item from the view", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            for (let i = 0; i < 5; i++) {
                state.items.set(i.toString(), new Item().assign({ amount: i }));
            }

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            client1.view.add(state.items.get("1"));
            client1.view.add(state.items.get("2"));
            client1.view.add(state.items.get("3"));
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.size, 3);

            client1.view.remove(state.items.get("2"));

            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(client1.state.items.size, 2);
        });

        it("mutating a view() property on child item (primitive)", () => {
            class Item extends Schema {
                @type("number") pub: number = 100;
                @view() @type("number") priv: number = 1;
            }

            class State extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const items: Item[] = [];

            for (let i = 0; i < 3; i++) {
                const item = new Item();
                items.push(item);
                state.items.set(i.toString(), item);
            }

            const client = createClientWithView(state);
            client.view.add(state.items.get("1"));
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(100, client.state.items.get("1").pub);
            assert.strictEqual(1, client.state.items.get("1").priv);

            items[1].pub++;
            items[1].priv++;

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(101, client.state.items.get("1").pub);
            assert.strictEqual(2, client.state.items.get("1").priv);
        });

        it("mutating a view() property on child item (Schema child)", () => {
            class Prop extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }
            class Item extends Schema {
                @type("number") pub: number = 100;
                @view() @type(Prop) priv: Prop = new Prop().assign({ name: "test", value: 1 });
            }

            class State extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const items: Item[] = [];

            for (let i = 0; i < 3; i++) {
                const item = new Item();
                items.push(item);
                state.items.set(i.toString(), item);
            }

            const client = createClientWithView(state);
            client.view.add(state.items.get("1"));
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(100, client.state.items.get("1").pub);
            assert.strictEqual(1, client.state.items.get("1").priv.value);

            items[1].pub++;
            items[1].priv.value++;

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(101, client.state.items.get("1").pub);
            assert.strictEqual(2, client.state.items.get("1").priv.value);
        });

        it("adding to view item that has been removed from state", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
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
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.size, 1);
            assert.strictEqual(client1.state.items.get("3").amount, state.items.get("3").amount);

            client1.view.add(state.items.get("3"));
            state.items.delete("3");

            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(client1.state.items.size, 0);

        });

        it("should support add + remove + add of complex items", () => {
            class Component extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }

            class ListComponent extends Component {
                @type(["string"]) list: string[] = new ArraySchema<string>();
            }

            class TagComponent extends Component {
                @type("string") tag: string;
            }

            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
                @type([Component]) components: Component[] = new ArraySchema<Component>();
            }

            class MyRoomState extends Schema {
                @view() @type({ map: Entity }) entities = new Map<string, Entity>();
            }

            const state = new MyRoomState();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            state.entities.set("one", new Entity().assign({
                id: "one",
                components: [
                    new Component().assign({ name: "Health", value: 100 }),
                    new ListComponent().assign({ name: "List", value: 200, list: ["one", "two"] }),
                    new TagComponent().assign({ name: "Tag", value: 300, tag: "tag" }),
                ]
            }));

            state.entities.set("two", new Entity().assign({
                id: "two",
                components: [
                    new Component().assign({ name: "Health", value: 100 }),
                    new ListComponent().assign({ name: "List", value: 200, list: ["one", "two"] }),
                    new TagComponent().assign({ name: "Tag", value: 300, tag: "tag" }),
                ]
            }));

            encodeMultiple(encoder, state, [client1, client2]);

            // add entities for the first time
            client1.view.add(state.entities.get("one"));
            client2.view.add(state.entities.get("two"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(1, client1.state.entities.size);
            assert.strictEqual(3, client1.state.entities.get("one").components.length);

            assert.strictEqual(1, client2.state.entities.size);
            assert.strictEqual(3, client2.state.entities.get("two").components.length);

            // remove entity from state view
            client1.view.remove(state.entities.get("one"));
            client2.view.remove(state.entities.get("two"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(0, client1.state.entities.size);
            assert.strictEqual(0, client2.state.entities.size);

            // re-add entities!
            client1.view.add(state.entities.get("one"));
            client2.view.add(state.entities.get("two"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(1, client1.state.entities.size);
            assert.strictEqual(3, client1.state.entities.get("one").components.length);

            assert.strictEqual(1, client2.state.entities.size);
            assert.strictEqual(3, client2.state.entities.get("two").components.length);
        });

        it("should allow to .clear() the view", () => {
            class Component extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }

            class ListComponent extends Component {
                @type(["string"]) list: string[] = new ArraySchema<string>();
            }

            class TagComponent extends Component {
                @type("string") tag: string;
            }

            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
                @type([Component]) components: Component[] = new ArraySchema<Component>();
            }

            class MyRoomState extends Schema {
                @view() @type({ map: Entity }) entities = new Map<string, Entity>();
            }

            const state = new MyRoomState();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state, new StateView(true));
            const client2 = createClientWithView(state, new StateView(true));

            state.entities.set("one", new Entity().assign({
                id: "one",
                components: [
                    new Component().assign({ name: "Health", value: 100 }),
                    new ListComponent().assign({ name: "List", value: 200, list: ["one", "two"] }),
                    new TagComponent().assign({ name: "Tag", value: 300, tag: "tag" }),
                ]
            }));

            state.entities.set("two", new Entity().assign({
                id: "two",
                components: [
                    new Component().assign({ name: "Health", value: 100 }),
                    new ListComponent().assign({ name: "List", value: 200, list: ["one", "two"] }),
                    new TagComponent().assign({ name: "Tag", value: 300, tag: "tag" }),
                ]
            }));

            encodeMultiple(encoder, state, [client1, client2]);

            // add entities for the first time
            client1.view.add(state.entities.get("one"));
            client2.view.add(state.entities.get("two"));

            assert.strictEqual(1, client1.view.items.length);
            assert.strictEqual(1, client2.view.items.length);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(1, client1.state.entities.size);
            assert.strictEqual(3, client1.state.entities.get("one").components.length);

            assert.strictEqual(1, client2.state.entities.size);
            assert.strictEqual(3, client2.state.entities.get("two").components.length);

            client1.view.clear();
            client2.view.clear();

            assert.strictEqual(0, client1.view.items.length);
            assert.strictEqual(0, client2.view.items.length);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(0, client1.state.entities.size);
            assert.strictEqual(0, client2.state.entities.size);

            // re-add entities!
            client1.view.add(state.entities.get("one"));
            client2.view.add(state.entities.get("two"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(1, client1.state.entities.size);
            assert.strictEqual(3, client1.state.entities.get("one").components.length);

            assert.strictEqual(1, client2.state.entities.size);
            assert.strictEqual(3, client2.state.entities.get("two").components.length);

        });

        it("view.remove() should only remove tagged field and not the whole structure", () => {
            class Card extends Schema {
                @view() @type("string") cardId: string;
                @type("string") zone: string;
                @type("number") index: number;
            }
            class State extends Schema {
                @type({ map: Card }) cards = new MapSchema();
            }
            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            const card1 = new Card().assign({ cardId: "card1", zone: "zone1", index: 0 });
            const card2 = new Card().assign({ cardId: "card2", zone: "zone2", index: 0 })
            const card3 = new Card().assign({ cardId: "card3", zone: "zone3", index: 0 });
            state.cards.set("1", card1);
            state.cards.set("2", card2);
            state.cards.set("3", card3);

            client1.view.add(card1);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(3, client1.state.cards.size);
            assert.strictEqual("card1", client1.state.cards.get("1").cardId);
            assert.strictEqual(undefined, client1.state.cards.get("2").cardId);
            assert.strictEqual(undefined, client1.state.cards.get("3").cardId);

            // remove from view
            client1.view.remove(card1);
            encodeMultiple(encoder, state, [client1]);

            // mutate removed item
            card1.zone = "zone2";
            card1.index = 1;
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(undefined, client1.state.cards.get("1").cardId);
            assert.strictEqual("zone2", client1.state.cards.get("1").zone);
            assert.strictEqual(1, client1.state.cards.get("1").index);

            assert.strictEqual(undefined, client1.state.cards.get("2").cardId);
            assert.strictEqual(undefined, client1.state.cards.get("3").cardId);

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        it("should support late add and late remove of items from view", () => {
            class Item extends Schema {
                @type('number') i: number;
            }
            class State extends Schema {
                @view() @type({ map: Item }) items = new MapSchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const item1 = new Item().assign({ i: 1 });
            const item2 = new Item().assign({ i: 2 });
            const item3 = new Item().assign({ i: 3 });
            state.items.set("1", item1);
            state.items.set("2", item2);
            state.items.set("3", item3);

            encoder.discardChanges();
            encodeMultiple(encoder, state, []);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            assert.deepStrictEqual(client.state.items, undefined);

            client.view.add(item1);
            encodeMultiple(encoder, state, [client]);

            assert.deepStrictEqual(client.state.items.get("1").toJSON(), item1.toJSON());
        });

        it("view.remove() should remove nested items (1 level)", () => {
            class Coordinates extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }
            class Diamond extends Schema {
                @type(Coordinates) position: Coordinates;
            }
            class State extends Schema {
                @view() @type({ map: Diamond }) diamonds = new MapSchema<Diamond>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const diamond = new Diamond().assign({
                position: new Coordinates().assign({ x: 10, y: 20 })
            });
            state.diamonds.set("one", diamond);

            const client1 = createClientWithView(state);
            client1.view.add(diamond);
            encodeMultiple(encoder, state, [client1]);

            client1.view.remove(diamond);
            encodeMultiple(encoder, state, [client1]);

            diamond.position.x++;
            encodeMultiple(encoder, state, [client1]);

            assert.doesNotThrow(() =>
                encodeAllMultiple(encoder, state, [client1]));
        });

        it("view.remove() should remove nested items (2 levels)", () => {
            class Tag extends Schema {
                @type("string") name: string;
            }
            class Coordinates extends Schema {
                @type("number") x: number;
                @type("number") y: number;
                @type(Tag) tag: Tag;
            }
            class Diamond extends Schema {
                @type(Coordinates) position: Coordinates;
            }
            class State extends Schema {
                @view() @type({ map: Diamond }) diamonds = new MapSchema<Diamond>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const diamond = new Diamond().assign({
                position: new Coordinates().assign({ x: 10, y: 20, tag: new Tag().assign({ name: "tag1" }) })
            });
            state.diamonds.set("one", diamond);

            const client1 = createClientWithView(state);
            client1.view.add(diamond);
            encodeMultiple(encoder, state, [client1]);

            client1.view.remove(diamond);
            encodeMultiple(encoder, state, [client1]);

            assert.doesNotThrow(() =>
                encodeAllMultiple(encoder, state, [client1]));
        });

        it("removing and re-adding multiple times", () => {
            // Thanks @jcrowson for providing this scenario

            class NPCState extends Schema {
                @view() @type('number') x: number = 0;
                @view() @type('number') y: number = 0;
            }

            class State extends Schema {
                @view() @type({ map: NPCState }) npcs = new MapSchema<NPCState>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const ids = ['0', '1', '2', '3'];
            ids.forEach(id => state.npcs.set(id, new NPCState().assign({ x: 1, y: 1 })));

            const client1 = createClientWithView(state);
            client1.view.add(state.npcs.get('0'));
            client1.view.add(state.npcs.get('1'));
            client1.view.add(state.npcs.get('2'));

            encodeMultiple(encoder, state, [client1]);

            client1.view.add(state.npcs.get('3'));
            client1.view.remove(state.npcs.get('3'));
            encodeMultiple(encoder, state, [client1]);

            assertEncodeAllMultiple(encoder, state, [client1]);
        })

        it("should not throw 'refId not found' error when swapping and mutating shared Inventory items with StateView", () => {
            class Item extends Schema {
                @type("string") name: string;
            }

            class Inventory extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
            }

            class GameState extends Schema {
                @view() @type({ map: Inventory }) inventories = new MapSchema<Inventory>();
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            // Create inventories
            const playerInv = new Inventory();
            const shopInv = new Inventory();
            const storageInv = new Inventory();

            state.inventories.set("player1", playerInv);
            state.inventories.set("shop1", shopInv);
            state.inventories.set("storage1", storageInv);

            // Place items in inventories
            playerInv.items.set("sword", new Item().assign({ name: "Sword" }));
            shopInv.items.set("ring", new Item().assign({ name: "Potion" }));
            storageInv.items.set("potion", new Item().assign({ name: "Ring" }));

            // Create clients with different views
            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Initial encode
            encodeMultiple(encoder, state, [client1, client2]);

            // Add different inventories to different client views
            client1.view.add(playerInv);
            client2.view.add(shopInv);

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 2: Replace inventories with new instances while preserving shared items
            const newStorageInv = new Inventory();

            // Copy items from storage to new inventory (creating shared references)
            state.inventories.get("storage1").items.forEach((item, itemKey) =>
                newStorageInv.items.set(itemKey, item));

            // Replace inventories in state
            state.inventories.set("storage1", newStorageInv);
            state.inventories.set("player1", newStorageInv);
            state.inventories.set("storage1", storageInv);

            // Update client views to include the new inventory
            client1.view.add(newStorageInv);
            client2.view.add(storageInv);

            // console.log(Schema.debugRefIds(state))
            // console.log("Encode order =>", Schema.debugRefIdEncodingOrder(state, "filteredChanges"));
            // console.log("StateView order =>", Array.from(client1.view.changes.keys()));

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 3: Swap inventories again to force refId ordering issues
            const newShopInv = new Inventory();

            // Copy items from shop to new inventory
            shopInv.items.forEach((item, itemKey) =>
                newShopInv.items.set(itemKey, item));

            // This operation can cause "Ring" reference to appear before its parent
            state.inventories.set("shop1", newShopInv);
            state.inventories.set("storage1", shopInv);//

            // Update client views
            client1.view.add(newShopInv);
            client2.view.add(shopInv);

            // console.log(Schema.debugRefIds(state))
            // console.log("Encode order =>", Schema.debugRefIdEncodingOrder(state));
            // console.log("StateView order =>", Array.from(client1.view.changes.keys()));

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 4: Mutate shared items to trigger encoding issues
            const sharedItem = newStorageInv.items.get("potion");
            if (sharedItem) {
                sharedItem.name = "Modified Ring";
            }

            // console.log(Schema.debugRefIds(state))
            // console.log("Encode order =>", Schema.debugRefIdEncodingOrder(state, 'filteredChanges'));
            // console.log("StateView order =>", Array.from(client1.view.changes.keys()));
            // console.log("DECODER REF IDS =>" + Schema.debugRefIdsFromDecoder(getDecoder(client1.state)));

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 5: Remove and re-add items to force refId cleanup issues
            state.inventories.get("player1").items.delete("sword");
            state.inventories.get("player1").items.set("sword", new Item().assign({ name: "New Sword" }));

            encodeMultiple(encoder, state, [client1, client2]);

            console.log("STATE =>", Schema.debugRefIds(state))
            console.log("Encode order =>", Schema.debugRefIdEncodingOrder(state, 'allFilteredChanges'));
            console.log("DECODER REF IDS =>" + Schema.debugRefIdsFromDecoder(getDecoder(client2.state)));

            //
            // TODO: fix not removing item from visible set when replacing a collection
            // - when inventories["storage1"] gets replaced by shopInv, the items previously inside storageInv remain in the view.visible set.
            // - when iterating over the 'allFilteredChanges' order, the refId 10 gets encoded for client2 because it is still on the view.visible set.
            //
            // assertEncodeAllMultiple(encoder, state, [client2]);
            // // assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle shared references with filtered properties in StateView", () => {
            class Item extends Schema {
                @type("string") name: string;
                @view() @type("string") secret: string;
            }

            class Inventory extends Schema {
                @type({ map: Item }) items = new MapSchema<Item>();
                @view() @type("string") owner: string;
            }

            class GameState extends Schema {
                @view() @type({ map: Inventory }) inventories = new MapSchema<Inventory>();
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            // Create shared item with filtered properties
            const sharedItem = new Item().assign({
                name: "Shared Item",
                secret: "Secret Info"
            });

            // Create inventories
            const playerInv = new Inventory().assign({ owner: "Player1" });
            const shopInv = new Inventory().assign({ owner: "Shop" });
            const storageInv = new Inventory().assign({ owner: "Storage" });

            state.inventories.set("player1", playerInv);
            state.inventories.set("shop1", shopInv);
            state.inventories.set("storage1", storageInv);

            // Add shared item to multiple inventories
            playerInv.items.set("shared", sharedItem);
            shopInv.items.set("shared", sharedItem);
            storageInv.items.set("shared", sharedItem);

            // Create clients with different views
            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Initial encode
            encodeMultiple(encoder, state, [client1, client2]);

            // Add different inventories to different client views
            client1.view.add(playerInv);
            client2.view.add(shopInv);

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 2: Create new inventory and move shared item
            const newInventory = new Inventory().assign({ owner: "New Owner" });
            newInventory.items.set("shared", sharedItem);

            // Replace one inventory with new one
            state.inventories.set("storage1", newInventory);

            // Update client views
            client1.view.add(newInventory);
            client2.view.add(newInventory);

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 3: Mutate shared item's filtered property
            sharedItem.secret = "Modified Secret";

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 4: Remove shared item from one inventory and add to another
            playerInv.items.delete("shared");
            shopInv.items.set("shared2", sharedItem);

            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 5: Create new shared item and replace existing one
            const newSharedItem = new Item().assign({
                name: "New Shared Item",
                secret: "New Secret"
            });

            // Replace shared item in all inventories
            playerInv.items.set("shared", newSharedItem);
            shopInv.items.set("shared", newSharedItem);
            newInventory.items.set("shared", newSharedItem);

            // must add shared item to view before encoding
            // TODO: it should not be required to do this! though it is because the parent structure must link to the child
            // client1.view.add(newSharedItem);
            client2.view.add(newSharedItem);

            encodeMultiple(encoder, state, [client1, client2]);

            // encodeMultiple(encoder, state, [client2]);
            encodeMultiple(encoder, state, [client1, client2]);

            // Phase 6: Remove and re-add inventories to force refId reordering
            state.inventories.delete("player1");
            state.inventories.set("player1", playerInv);

            encodeMultiple(encoder, state, [client1, client2]);

            // assertEncodeAllMultiple(encoder, state, [client1, client2]);
            assertEncodeAllMultiple(encoder, state, [client2]);
        });

        it(".clear() and isVisibilitySharedWithParent", () => {
            class CardState extends Schema {
                @type('string') suit: string;
                @type('string') rank: string;
            }

            class PlayerState extends Schema {
                @type('string') sessionId: string;
                @type('number') chips: number;
                @view() @type({ map: CardState }) holeCards = new MapSchema<CardState>();
            }

            class PokerRoomState extends Schema {
                @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
            }

            const state = new PokerRoomState();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);

            // Create a player with hole cards
            const player = new PlayerState();
            player.sessionId = "player1";
            player.chips = 1000;

            const card1 = new CardState();
            card1.suit = "hearts";
            card1.rank = "A";

            const card2 = new CardState();
            card2.suit = "spades";
            card2.rank = "K";

            player.holeCards.set("card1", card1);
            player.holeCards.set("card2", card2);

            state.players.set("player1", player);

            // Initial encode
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.size, 1);
            assert.strictEqual(client.state.players.get("player1").holeCards, undefined);

            // Add player to view to make holeCards visible
            client.view.add(player);

            // Add individual cards to view to simulate the user's setup
            client.view.add(card1);
            client.view.add(card2);

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.get("player1").holeCards.size, 2);
            assert.strictEqual(client.state.players.get("player1").holeCards.get("card1").suit, "hearts");
            assert.strictEqual(client.state.players.get("player1").holeCards.get("card1").rank, "A");

            // This should reproduce the error: clear() with isVisibilitySharedWithParent
            // The error occurs because clear() empties tmpItems but the filter function
            // still tries to access tmpItems[index]?.[`$changes`] which becomes undefined
            player.holeCards.clear();

            // Try to encode after clear() - this should trigger the error
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.get("player1").holeCards.size, 0);

            assertEncodeAllMultiple(encoder, state, [client]);
        });

    });

    describe("ArraySchema", () => {
        it("should support filtering out entire array of primitive types", () => {
            class State extends Schema {
                @view() @type(["string"]) items = new ArraySchema<string>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            for (let i = 0; i < 3; i++) {
                state.items.push(i.toString());
            }

            client2.view.add(state.items);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.items, undefined);
            assert.deepStrictEqual(client2.state.items.toArray(), ["0", "1", "2"]);

            assertEncodeAllMultiple(encoder, state, [client1, client2])
        })

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

        it("removing and item should remove from their views", () => {
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

            client1.view.add(state.items.at(2));
            client1.view.add(state.items.at(3));

            client2.view.add(state.items.at(3));
            client2.view.add(state.items.at(4));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.items.map(i => i.amount), [2, 3]);
            assert.deepStrictEqual(client2.state.items.map(i => i.amount), [3, 4]);

            state.items.splice(3, 1)
            assert.deepStrictEqual(state.items.map(i => i.amount), [0, 1, 2, 4]);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.items.map(i => i.amount), [2]);
            assert.deepStrictEqual(client2.state.items.map(i => i.amount), [4]);

            assertEncodeAllMultiple(encoder, state, [client1, client2])
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

            const newSong = new Song().assign({ url: "song2" });
            state.buckets.get(sessionId).queue.push(newSong);

            state.queue = new ArraySchema<Song>();
            state.queue.push(newSong);

            client1.view.add(state.queue);
            client1.view.add(newSong);

            encodeMultiple(encoder, state, [client1]);

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

        it("should not be required to manually call view.add() items to child arrays without @view() tag", () => {
            class Item extends Schema {
                @type("string") name: string;
            }
            class Entity extends Schema {
                @type(["string"]) strings: string[];
                @type([Item]) items: Item[];
            }

            class State extends Schema {
                @view() @type([Entity]) entities = new ArraySchema<Entity>();
            }

            const state = new State();
            for (let i = 0; i < 5; i++) {
                state.entities.push(new Entity().assign({
                    strings: ["one"],
                    items: [new Item().assign({ name: "one" })]
                }));
            }

            const encoder = getEncoder(state);

            const client = createClientWithView(state);
            client.view.add(state.entities.at(3));

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.length, 1);
            assert.strictEqual(1, client.state.entities[0].strings.length);
            assert.strictEqual(1, client.state.entities[0].items.length);
            assert.strictEqual("one", client.state.entities[0].strings[0]);
            assert.strictEqual("one", client.state.entities[0].items[0].name);

            assert.ok(client.view.isChangeTreeVisible(state.entities.at(3).items[$changes]))
            assert.ok(client.view.isChangeTreeVisible(state.entities.at(3).strings[$changes]))

            state.entities.at(3).strings.push("two");
            state.entities.at(3).items.push(new Item().assign({ name: "two" }));

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(2, client.state.entities[0].strings.length);
            assert.strictEqual(2, client.state.entities[0].items.length);

            assertEncodeAllMultiple(encoder, state, [client])
        });

        it("nested arrays of a filtered entity", () => {
            class Component extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }
            class QuestCondition extends Schema {
                @type('number') level: number = null;
                @type('string') quest: string = null;
            }
            class QuestReward extends Schema {
                @type('number') amount: number;
            }
            class QuestRequirement extends Schema {
                @type('number') progress: number = 0;
            }
            class Quest extends Schema {
                @type('string') name: string;
                @type([QuestRequirement]) requirements: QuestRequirement[] = new ArraySchema<QuestRequirement>();
                @type([QuestReward]) rewards: QuestReward[] = new ArraySchema<QuestReward>();
                @type([QuestCondition]) conditions: QuestCondition[] = new ArraySchema<QuestCondition>();
            }
            class QuestBook extends Component {
                @type([Quest]) finished: Quest[] = new ArraySchema<Quest>();
                @type([Quest]) ongoing: Quest[] = new ArraySchema<Quest>();
            }
            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
                @type([Component]) components: Component[] = new ArraySchema<Component>();
            }

            class MyRoomState extends Schema {
                @view() @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new MyRoomState();
            const encoder = getEncoder(state);

            const questBook = new QuestBook().assign({
                finished: [],
                ongoing: [
                    new Quest().assign({
                        name: "Quest1",
                        requirements: [new QuestRequirement().assign({ progress: 0 })],
                        rewards: [new QuestReward().assign({ amount: 300 })],
                        conditions: [new QuestCondition().assign({ level: 3, quest: "Quest1" })]
                    }),
                    new Quest().assign({
                        name: "Quest2",
                        requirements: [new QuestRequirement().assign({ progress: 0 })],
                        rewards: [new QuestReward().assign({ amount: 400 })],
                        conditions: [new QuestCondition().assign({ level: 4, quest: "Quest2" })]
                    }),
                    new Quest().assign({
                        name: "Quest3",
                        requirements: [new QuestRequirement().assign({ progress: 0 })],
                        rewards: [new QuestReward().assign({ amount: 400 })],
                        conditions: [new QuestCondition().assign({ level: 4, quest: "Quest3" })]
                    })
                ]
            });

            state.entities.set("one", new Entity().assign({
                id: "one",
                components: [questBook]
            }));

            state.entities.set("two", new Entity().assign({
                id: "two",
                components: []
            }));

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // add entities for the first time
            client.view.add(state.entities.get("one"));

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(1, client.state.entities.size);

            assert.deepStrictEqual(state.entities.get("one").toJSON(), client.state.entities.get("one").toJSON());

            // 1st remove ongoing + add to finished
            const ongoing1 = questBook.ongoing.shift();
            questBook.finished.push(ongoing1);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(state.entities.get("one").toJSON(), client.state.entities.get("one").toJSON());

            // 2st remove ongoing + add to finished
            const ongoing2 = questBook.ongoing.shift();
            questBook.finished.push(ongoing2);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(state.entities.get("one").toJSON(), client.state.entities.get("one").toJSON());

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("should allow clear and push on filtered array", () => {
            class Player extends Schema {
                @view() @type(["string"]) public hand = new ArraySchema<string>();
                @view() @type(["string"]) public deck = new ArraySchema<string>();
            }
            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }
            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            function createPlayer() {
                const player = new Player();
                for (let i = 0; i < 10; i++) {
                    player.deck.push(`card${i}`);
                }
                player.hand.push(player.deck.pop());
                player.hand.push(player.deck.pop());
                player.hand.push(player.deck.pop());
                return player;
            }

            const player1 = createPlayer();
            const player2 = createPlayer();

            state.players.set("one", player1);
            state.players.set("two", player2);

            encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(client1.state.players.size, 2);
            assert.strictEqual(client1.state.players.get("one").hand, undefined);
            assert.strictEqual(client2.state.players.size, 2);
            assert.strictEqual(client2.state.players.get("two").hand, undefined);

            client1.view.add(player1);
            client2.view.add(player2);

            encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(client1.state.players.size, 2);
            assert.strictEqual(client1.state.players.get("one").hand.length, 3);
            assert.strictEqual(client1.state.players.get("one").deck.length, 7);
            assert.strictEqual(client2.state.players.size, 2);
            assert.strictEqual(client2.state.players.get("two").hand.length, 3);
            assert.strictEqual(client2.state.players.get("two").deck.length, 7);

            player1.hand.clear();
            player1.hand.push("card1");
            player1.hand.push("card2");

            player2.hand.clear();
            player2.hand.push("card1");
            player2.hand.push("card2");

            encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(client1.state.players.get("one").hand.length, 2);
            assert.strictEqual(client1.state.players.get("one").deck.length, 7);
            assert.strictEqual(client2.state.players.get("two").hand.length, 2);
            assert.strictEqual(client2.state.players.get("two").deck.length, 7);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it(".clear() and isVisibilitySharedWithParent", () => {
            class CardState extends Schema {
                @type('string') suit: string;
                @type('string') rank: string;
            }

            class PlayerState extends Schema {
                @type('string') sessionId: string;
                @type('number') chips: number;
                @view() @type([CardState]) holeCards = new ArraySchema<CardState>();
            }

            class PokerRoomState extends Schema {
                @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
            }

            const state = new PokerRoomState();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);

            // Create a player with hole cards
            const player = new PlayerState();
            player.sessionId = "player1";
            player.chips = 1000;

            const card1 = new CardState();
            card1.suit = "hearts";
            card1.rank = "A";

            const card2 = new CardState();
            card2.suit = "spades";
            card2.rank = "K";

            player.holeCards.push(card1);
            player.holeCards.push(card2);

            state.players.set("player1", player);

            // Initial encode
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.size, 1);
            assert.strictEqual(client.state.players.get("player1").holeCards, undefined);

            // Add player to view to make holeCards visible
            client.view.add(player);

            // Add individual cards to view to simulate the user's setup
            client.view.add(card1);
            client.view.add(card2);

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.get("player1").holeCards.length, 2);
            assert.strictEqual(client.state.players.get("player1").holeCards[0].suit, "hearts");
            assert.strictEqual(client.state.players.get("player1").holeCards[0].rank, "A");

            // This should reproduce the error: clear() with isVisibilitySharedWithParent
            // The error occurs because clear() empties tmpItems but the filter function
            // still tries to access tmpItems[index]?.[`$changes`] which becomes undefined
            player.holeCards.clear();

            // Try to encode after clear() - this should trigger the error
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.get("player1").holeCards.length, 0);

            assertEncodeAllMultiple(encoder, state, [client]);
        })

        it("clear() + view.remove()", () => {
            class CardState extends Schema {
                @type('string') suit: string;
                @type('string') rank: string;
            }

            class PlayerState extends Schema {
                @type('string') sessionId: string;
                @type('number') chips: number;
                @view() @type([CardState]) holeCards = new ArraySchema<CardState>();
            }

            class PokerRoomState extends Schema {
                @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
            }

            const state = new PokerRoomState();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);

            // Create a player with hole cards
            const player = new PlayerState();
            player.sessionId = "player1";
            player.chips = 1000;

            const card1 = new CardState().assign({
                suit: "hearts",
                rank: "A"
            });

            const card2 = new CardState().assign({
                suit: "spades",
                rank: "K"
            });

            player.holeCards.push(card1);
            player.holeCards.push(card2);

            state.players.set("player1", player);

            // Create a second player with hole cards
            const player2 = new PlayerState();
            player2.sessionId = "player2";
            player2.chips = 1500;

            const card3 = new CardState().assign({
                suit: "diamonds",
                rank: "Q"
            });

            const card4 = new CardState().assign({
                suit: "clubs",
                rank: "J"
            });

            player2.holeCards.push(card3);
            player2.holeCards.push(card4);

            state.players.set("player2", player2);

            // Initial encode
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.size, 2);
            assert.strictEqual(client.state.players.get("player1").holeCards, undefined);

            // Add player to view to make holeCards visible
            client.view.add(player);

            // Add individual cards to view to simulate the user's setup
            client.view.add(card1);
            client.view.add(card2);

            // Add player2 to view to make holeCards visible
            client.view.add(player2);

            // Add individual cards for player2 to view
            client.view.add(card3);
            client.view.add(card4);

            encodeMultiple(encoder, state, [client]);

            // remove a player from the view + clear the holeCards + remove all cards
            state.players.delete("player2");
            state.players.forEach(player => {
                player.holeCards.forEach(card => {
                    client.view.remove(card)
                })
                player.holeCards.clear();
            });

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(undefined, client.state.players.get("player2"));
            assert.strictEqual(client.state.players.get("player1").holeCards.length, 0);

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("clear() + view.remove() + add new items", () => {
            class CardState extends Schema {
                @type('string') suit: string;
                @type('string') rank: string;
            }

            class PlayerState extends Schema {
                @type('string') sessionId: string;
                @type('number') chips: number;
                @view() @type([CardState]) holeCards = new ArraySchema<CardState>();
            }

            class PokerRoomState extends Schema {
                @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
            }

            const state = new PokerRoomState();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);

            // Create a player with hole cards
            const player = new PlayerState();
            player.sessionId = "player1";
            player.chips = 1000;

            const card1 = new CardState().assign({
                suit: "hearts",
                rank: "A"
            });

            const card2 = new CardState().assign({
                suit: "spades",
                rank: "K"
            });

            player.holeCards.push(card1);
            player.holeCards.push(card2);

            state.players.set("player1", player);

            // Create a second player with hole cards
            const player2 = new PlayerState();
            player2.sessionId = "player2";
            player2.chips = 1500;

            const card3 = new CardState().assign({
                suit: "diamonds",
                rank: "Q"
            });

            const card4 = new CardState().assign({
                suit: "clubs",
                rank: "J"
            });

            player2.holeCards.push(card3);
            player2.holeCards.push(card4);

            state.players.set("player2", player2);

            // Initial encode
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.players.size, 2);
            assert.strictEqual(client.state.players.get("player1").holeCards, undefined);

            // Add player to view to make holeCards visible
            client.view.add(player);

            // Add individual cards to view to simulate the user's setup
            client.view.add(card1);
            client.view.add(card2);

            // Add player2 to view to make holeCards visible
            client.view.add(player2);

            // Add individual cards for player2 to view
            client.view.add(card3);
            client.view.add(card4);

            encodeMultiple(encoder, state, [client]);

            // remove a player from the view + clear the holeCards + remove all cards
            state.players.delete("player2");
            state.players.forEach(player => {
                player.holeCards.forEach(card => {
                    client.view.remove(card)
                })
                player.holeCards.clear();
            });

            // add new card to player1
            const card5 = new CardState().assign({
                suit: "hearts",
                rank: "2"
            });

            // add new card to player1
            const card6 = new CardState().assign({
                suit: "hearts",
                rank: "3"
            });

            player.holeCards.push(card5);
            player.holeCards.push(card6);

            client.view.add(card5);
            client.view.add(card6);

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(undefined, client.state.players.get("player2"));
            assert.strictEqual(client.state.players.get("player1").holeCards.length, 2);
            assert.strictEqual(client.state.players.get("player1").holeCards[0].suit, "hearts");
            assert.strictEqual(client.state.players.get("player1").holeCards[0].rank, "2");
            assert.strictEqual(client.state.players.get("player1").holeCards[1].suit, "hearts");
            assert.strictEqual(client.state.players.get("player1").holeCards[1].rank, "3");

            assertEncodeAllMultiple(encoder, state, [client]);
        });

    });

    describe("Deep and nested structures", () => {
        it("@view() on SetSchema with CollectionSchema as child", () => {
            class PointState extends Schema {
                @type("number") x: number = 0
                @type("number") y: number = 0
            }
            class OrbState extends PointState {
                @type("string") id = Math.random().toString(36).substring(7);
                @type("uint8") score: number = 1
                @type("uint32") color: number = 0xff0000
            }
            class Zone extends Schema {
                @type({ collection: OrbState }) orbs = new CollectionSchema<OrbState>()
            }
            class Player extends Schema {
                @view() @type({ set: Zone }) loadedZones: SetSchema<Zone> = new SetSchema<Zone>()
            }
            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            const player = new Player();
            state.players.set("one", player);

            const zones: Zone[] = [];
            for (let i = 0; i < 3; i++) {
                const zone = new Zone();
                zone.orbs.add(new OrbState());
                zone.orbs.add(new OrbState());
                player.loadedZones.add(zone);
                zones.push(zone);
            }

            client1.view.add(zones[0]);

            // console.log(Schema.debugRefIds(state));
            // console.log("Encode order =>", Schema.debugRefIdEncodingOrder(state, "filteredChanges"));
            // console.log("StateView order =>", Array.from(client1.view.changes.keys()));

            encodeMultiple(encoder, state, [client1]);
            // console.log("client1.view =>", Schema.debugRefIdsFromDecoder(getDecoder(client1.state)));

            assert.strictEqual(2, client1.state.players.get('one').loadedZones.toArray()[0].orbs.size);

            assertEncodeAllMultiple(encoder, state, [client1])

            player.loadedZones.delete(zones[0]);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(0, client1.state.players.get('one').loadedZones.size);
            assertEncodeAllMultiple(encoder, state, [client1])
        });
    });

    describe("checkIsFiltered", () => {
        it("2nd level of @view() should be identified as 'filtered'", () => {
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
                @type(Component) component: Component;
            }

            class MyRoomState extends Schema {
                @view() @type({ map: Entity }) entities = new Map<string, Entity>();
                @type(Component) component: Component;
            }


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

            // @ts-ignore
            entity.components.push(new ListComponent().assign({ list: new ArraySchema("one", "two") }));
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

    describe("StateView.remove()", () => {
        it("should handle undefined changeTree.parent when filtered item loses parent reference", () => {
            class Item extends Schema {
                @view() @type("string") secret: string;
                @type("number") value: number;
            }

            class State extends Schema {
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            // Create items and add them to state
            const item1 = new Item().assign({ secret: "secret1", value: 1 });
            const item2 = new Item().assign({ secret: "secret2", value: 2 });

            state.items.push(item1);
            state.items.push(item2);

            // Add specific items to view (not the parent array)
            client1.view.add(item1);
            client1.view.add(item2);

            encodeMultiple(encoder, state, [client1]);

            // Simulate a scenario where the parent array gets replaced entirely
            // This should leave the items' changeTree.parent references undefined
            const newItems = new ArraySchema<Item>();
            state.items = newItems;

            // Try to remove items from view while their parent references are broken
            // This should trigger the undefined changeTree.parent issue
            client1.view.remove(item1);
            client1.view.remove(item2);

            // This encode should trigger the issue where changeTree.parent is undefined
            // but the code tries to access it in the remove method
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.items.length, 0);

            assertEncodeAllMultiple(encoder, state, [client1]);
        });
    });

    it("should encode nested Schema", () => {
        const state = new InheritanceRoot();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state.parent);

        // Initial encode: child property is undefined
        encodeMultiple(encoder, state, [client]);

        // Assign a child Schema instance.
        state.parent.standardChild = new Position(1, 2, 3);

        /**
         * Encode an assignment of a child field:
         * Its fields should be visible to the client, because it inherits visibility from its parent.
         */
        encodeMultiple(encoder, state, [client]);

        assert.notStrictEqual(client.state.parent, undefined);
        assert.notStrictEqual(client.state.parent.standardChild, undefined);
        assert.strictEqual(client.state.parent.standardChild.x, 1);
        assert.strictEqual(client.state.parent.standardChild.y, 2);
        assert.strictEqual(client.state.parent.standardChild.z, 3);
    });

    it("should not encode nested Schema with @view", () => {
        const state = new InheritanceRoot();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state.parent);

        // Initial encode: child property is undefined
        encodeMultiple(encoder, state, [client]);

        // Assign a child Schema that uses @view
        state.parent.viewChild = new Position(1, 2, 3);

        /**
         * Encode an assignment of a child field:
         * the child "viewChild" field (Position) is marked with @view,
         * so it does not share visibility with its parent, and
         * its fields are not encoded for the client.
         */
        encodeMultiple(encoder, state, [client]);

        assert.notStrictEqual(client.state.parent, undefined);
        assert.notStrictEqual(client.state.parent.viewChild, undefined);
        assert.strictEqual(client.state.parent.viewChild.x, undefined);
        assert.strictEqual(client.state.parent.viewChild.y, undefined);
        assert.strictEqual(client.state.parent.viewChild.z, undefined);
    });

    it("should encode nested Schema wrapped in ArraySchema", () => {
        const state = new InheritanceRoot();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state.parent);

        // Initial encode: child property is undefined
        encodeMultiple(encoder, state, [client]);

        // Assign a child Schema wrapped in an ArraySchema, to demonstrate this workaround.
        state.parent.arrayChild.push(new Position(1, 2, 3));

        /**
         * Encode an assignment of a child field wrapped in an ArraySchema
         * the child "arrayChild" field (Position) shares visibility with its parent,
         * and its fields are encoded for the client.
         */
        encodeMultiple(encoder, state, [client]);

        assert.notStrictEqual(client.state.parent, undefined);
        assert.strictEqual(client.state.parent.arrayChild.length, 1);
        assert.strictEqual(client.state.parent.arrayChild[0].x, 1);
        assert.strictEqual(client.state.parent.arrayChild[0].y, 2);
        assert.strictEqual(client.state.parent.arrayChild[0].z, 3);
    });

});
