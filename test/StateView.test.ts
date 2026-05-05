import * as assert from "assert";
import * as util from "util";
import { Schema, type, view, ArraySchema, MapSchema, StateView, Encoder, ChangeTree, $changes, $refId, OPERATION, SetSchema, CollectionSchema } from "../src";
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

            // With addParentOf gating its entry-write on hasFilteredFields,
            // a non-filtered ancestor (here: `state` itself, the immediate
            // parent of `item`) no longer emits a duplicate ADD on its
            // `item` index. The view pass now emits only the new tagged
            // scalar — 4 bytes total instead of the previous 8:
            //   [SWITCH_TO_STRUCTURE, item_refId, OP|field_index, value]
            // Bytes [0] (SWITCH) and [1] (item refId) are stable across
            // encodes; bytes [2] and [3] differ because Tag.ONE and
            // Tag.TWO route to different field indices/values.
            assert.strictEqual(4, Array.from(encodedTag1).length, "should encode only the new field");
            assert.strictEqual(Array.from(encodedTag1).length, Array.from(encodedTag2).length, "encode size should be the same");
            assert.strictEqual(Array.from(encodedTag1)[0], Array.from(encodedTag2)[0]);
            assert.strictEqual(Array.from(encodedTag1)[1], Array.from(encodedTag2)[1]);

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
            assert.strictEqual(true, state[$changes].hasFilteredFields);

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

    describe("Spatial view with dynamic entities (refId not found)", () => {
        /**
         * Reproduces the "refId not found" / "Schema refId not ready" error.
         * The pattern involves:
         * - Non-filtered MapSchemas containing entities with @view() fields
         * - A nested container object with sub-MapSchemas of @view() entities
         * - Spatial view updates (add/remove entities as players move)
         * - Dynamic entity creation/removal during gameplay
         */

        class MovableSchema extends Schema {
            @view() @type("uint32") x: number = 0;
            @view() @type("uint32") y: number = 0;
        }

        class NpcSchema extends MovableSchema {
            @view() @type("boolean") hidden: boolean = false;
            @view() @type("int16") hitpoints: number = 0;
            @view() @type("string") npcId: string = "npc_unknown";
            @view() @type("string") name: string = "Unknown";
        }

        class PlayerSchema extends MovableSchema {
            @view() @type("boolean") hidden: boolean = false;
            @view() @type("uint16") combatLevel: number = 0;
            @view() @type("string") name: string = "";
        }

        class ObjectSchema extends Schema {
            @view() @type("boolean") defined: boolean = true;
        }

        class TrainingDummySchema extends ObjectSchema {
            @view() @type("uint32") x: number = 0;
            @view() @type("uint32") y: number = 0;
            @view() @type("int16") hitpoints: number = 0;
            @view() @type("string") subtype: string = "dummy";
        }

        class DynamicObjectSchema extends ObjectSchema {
            @view() @type("uint32") x: number = 0;
            @view() @type("uint32") y: number = 0;
            @view() @type("string") subtype: string = "";
        }

        class WorldObjectsSchema extends Schema {
            @type({ map: TrainingDummySchema }) trainingDummies = new MapSchema<TrainingDummySchema>();
            @type({ map: DynamicObjectSchema }) dynamicObjects = new MapSchema<DynamicObjectSchema>();
        }

        class RoomState extends Schema {
            @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
            @type({ map: NpcSchema }) npcs = new MapSchema<NpcSchema>();
            @type(WorldObjectsSchema) objects = new WorldObjectsSchema();
        }

        it("should handle spatial view add/remove of entities with @view() fields", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            // Add some NPCs and training dummies to the world
            const npc1 = new NpcSchema().assign({ npcId: "goblin_1", name: "Goblin", x: 100, y: 100, hitpoints: 50 });
            const npc2 = new NpcSchema().assign({ npcId: "goblin_2", name: "Goblin", x: 200, y: 200, hitpoints: 50 });
            const npc3 = new NpcSchema().assign({ npcId: "goblin_3", name: "Goblin", x: 300, y: 300, hitpoints: 50 });
            state.npcs.set("npc1", npc1);
            state.npcs.set("npc2", npc2);
            state.npcs.set("npc3", npc3);

            const dummy1 = new TrainingDummySchema().assign({ x: 150, y: 150, hitpoints: 100, subtype: "dummy" });
            state.objects.trainingDummies.set("dummy1", dummy1);

            // Player joins - initial encode with no view items
            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            // Player's spatial hash detects nearby entities
            client1.view.add(npc1);
            client1.view.add(dummy1);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.size, 3); // all NPCs visible (map not filtered)
            assert.strictEqual(client1.state.npcs.get("npc1").name, "Goblin"); // view fields visible
            assert.strictEqual(client1.state.npcs.get("npc2").name, undefined); // not in view
            assert.strictEqual(client1.state.objects.trainingDummies.get("dummy1").hitpoints, 100);

            // Player moves - npc1 leaves range, npc2 enters range
            client1.view.remove(npc1);
            client1.view.add(npc2);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("npc1").name, undefined); // removed from view
            assert.strictEqual(client1.state.npcs.get("npc2").name, "Goblin"); // added to view

            // Dynamically spawn a new training dummy while player is nearby
            const dummy2 = new TrainingDummySchema().assign({ x: 200, y: 200, hitpoints: 100, subtype: "dummy" });
            state.objects.trainingDummies.set("dummy2", dummy2);
            client1.view.add(dummy2);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.objects.trainingDummies.get("dummy2").hitpoints, 100);

            // Mutate viewed entity
            npc2.hitpoints = 25;
            dummy2.hitpoints = 50;
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("npc2").hitpoints, 25);
            assert.strictEqual(client1.state.objects.trainingDummies.get("dummy2").hitpoints, 50);

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        it("should handle dynamic NPC removal while in view + new NPC spawn", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            const npc1 = new NpcSchema().assign({ npcId: "goblin_1", name: "Goblin", x: 100, y: 100, hitpoints: 50 });
            const npc2 = new NpcSchema().assign({ npcId: "goblin_2", name: "Goblin", x: 150, y: 150, hitpoints: 50 });
            state.npcs.set("npc1", npc1);
            state.npcs.set("npc2", npc2);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Both clients see both NPCs in view
            client1.view.add(npc1);
            client1.view.add(npc2);
            client2.view.add(npc1);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("npc1").name, "Goblin");
            assert.strictEqual(client1.state.npcs.get("npc2").name, "Goblin");
            assert.strictEqual(client2.state.npcs.get("npc1").name, "Goblin");
            assert.strictEqual(client2.state.npcs.get("npc2").name, undefined);

            // NPC1 dies and is removed from state while both clients have it in view
            client1.view.remove(npc1);
            client2.view.remove(npc1);
            state.npcs.delete("npc1");

            // Simultaneously, a new NPC spawns
            const npc3 = new NpcSchema().assign({ npcId: "goblin_3", name: "Goblin Elite", x: 100, y: 100, hitpoints: 100 });
            state.npcs.set("npc3", npc3);
            client1.view.add(npc3);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("npc1"), undefined);
            assert.strictEqual(client1.state.npcs.get("npc3").name, "Goblin Elite");
            assert.strictEqual(client2.state.npcs.get("npc1"), undefined);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle multiple clients with overlapping spatial views and dynamic entity lifecycle", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            // Pre-populate world
            const npcs: NpcSchema[] = [];
            for (let i = 0; i < 5; i++) {
                const npc = new NpcSchema().assign({ npcId: `npc_${i}`, name: `NPC ${i}`, x: i * 100, y: i * 100, hitpoints: 50 + i * 10 });
                npcs.push(npc);
                state.npcs.set(`npc${i}`, npc);
            }

            const dummy1 = new TrainingDummySchema().assign({ x: 50, y: 50, hitpoints: 100 });
            const dummy2 = new TrainingDummySchema().assign({ x: 250, y: 250, hitpoints: 100 });
            state.objects.trainingDummies.set("dummy1", dummy1);
            state.objects.trainingDummies.set("dummy2", dummy2);

            // Two players connect
            const player1 = new PlayerSchema().assign({ name: "Player1", x: 100, y: 100, combatLevel: 10 });
            const player2 = new PlayerSchema().assign({ name: "Player2", x: 300, y: 300, combatLevel: 20 });
            state.players.set("p1", player1);
            state.players.set("p2", player2);

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Initial encode - no view items yet
            encodeMultiple(encoder, state, [client1, client2]);

            // Player1's spatial view: nearby NPCs and dummies
            client1.view.add(player1);
            client1.view.add(npcs[0]);
            client1.view.add(npcs[1]);
            client1.view.add(dummy1);

            // Player2's spatial view: different set of nearby entities
            client2.view.add(player2);
            client2.view.add(npcs[2]);
            client2.view.add(npcs[3]);
            client2.view.add(dummy2);

            // Both players can see each other's non-@view() data
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.players.get("p1").name, "Player1");
            assert.strictEqual(client1.state.players.get("p2").name, undefined); // p2 not in client1's view
            assert.strictEqual(client2.state.players.get("p1").name, undefined);
            assert.strictEqual(client2.state.players.get("p2").name, "Player2");

            // Simulate game tick: players move, spatial views change
            // Player1 moves toward player2
            player1.x = 250;
            player1.y = 250;

            // Update spatial views: npc0 leaves, npc2 enters for client1
            client1.view.remove(npcs[0]);
            client1.view.remove(dummy1);
            client1.view.add(npcs[2]); // now in range
            client1.view.add(player2); // player2 now in range
            client1.view.add(dummy2);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("npc0").name, undefined); // removed
            assert.strictEqual(client1.state.npcs.get("npc2").name, "NPC 2"); // added
            assert.strictEqual(client1.state.players.get("p2").name, "Player2"); // now visible

            // Dynamically spawn a new NPC near both players
            const newNpc = new NpcSchema().assign({ npcId: "boss_1", name: "Boss", x: 260, y: 260, hitpoints: 500 });
            state.npcs.set("boss1", newNpc);

            // Both clients detect it in their spatial hash
            client1.view.add(newNpc);
            client2.view.add(newNpc);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("boss1").name, "Boss");
            assert.strictEqual(client2.state.npcs.get("boss1").name, "Boss");

            // Boss takes damage
            newNpc.hitpoints = 300;
            encodeMultiple(encoder, state, [client1, client2]);
            assert.strictEqual(client1.state.npcs.get("boss1").hitpoints, 300);
            assert.strictEqual(client2.state.npcs.get("boss1").hitpoints, 300);

            // Boss dies - remove from state and views
            client1.view.remove(newNpc);
            client2.view.remove(newNpc);
            state.npcs.delete("boss1");

            // At the same time, a training dummy gets destroyed and replaced
            state.objects.trainingDummies.delete("dummy2");
            const dummy3 = new TrainingDummySchema().assign({ x: 260, y: 260, hitpoints: 100 });
            state.objects.trainingDummies.set("dummy3", dummy3);
            client1.view.add(dummy3);
            client2.view.add(dummy3);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("boss1"), undefined);
            assert.strictEqual(client1.state.objects.trainingDummies.get("dummy3").hitpoints, 100);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle rapid add/remove cycles (entity flickering in/out of view range)", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            const npc = new NpcSchema().assign({ npcId: "npc_1", name: "Guard", x: 100, y: 100, hitpoints: 100 });
            state.npcs.set("npc1", npc);

            const dummy = new TrainingDummySchema().assign({ x: 100, y: 100, hitpoints: 50 });
            state.objects.trainingDummies.set("dummy1", dummy);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            // Rapid add/remove (entity on boundary of view range, flickering)
            for (let i = 0; i < 5; i++) {
                client1.view.add(npc);
                client1.view.add(dummy);
                encodeMultiple(encoder, state, [client1]);

                // Mutate while visible
                npc.hitpoints = 100 - i * 10;
                dummy.hitpoints = 50 - i * 5;
                encodeMultiple(encoder, state, [client1]);

                client1.view.remove(npc);
                client1.view.remove(dummy);
                encodeMultiple(encoder, state, [client1]);
            }

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        it("should handle late-joining client with existing dynamic entities", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            // World already has entities
            const npc1 = new NpcSchema().assign({ npcId: "npc_1", name: "Guard", x: 100, y: 100, hitpoints: 100 });
            state.npcs.set("npc1", npc1);

            const dummy1 = new TrainingDummySchema().assign({ x: 150, y: 150, hitpoints: 100 });
            state.objects.trainingDummies.set("dummy1", dummy1);

            // First client
            const client1 = createClientWithView(state);
            client1.view.add(npc1);
            client1.view.add(dummy1);
            encodeMultiple(encoder, state, [client1]);

            // Some game ticks pass, entity is mutated
            npc1.hitpoints = 75;
            dummy1.hitpoints = 50;
            encodeMultiple(encoder, state, [client1]);

            // More entities added dynamically
            const npc2 = new NpcSchema().assign({ npcId: "npc_2", name: "Thief", x: 200, y: 200, hitpoints: 40 });
            state.npcs.set("npc2", npc2);
            client1.view.add(npc2);
            encodeMultiple(encoder, state, [client1]);

            // Discard old changes (simulate server broadcastPatch cycle)
            encoder.discardChanges();

            // Second client joins late
            const client2 = createClientWithView(state);
            client2.view.add(npc1);
            client2.view.add(npc2);
            client2.view.add(dummy1);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client2.state.npcs.get("npc1").hitpoints, 75);
            assert.strictEqual(client2.state.npcs.get("npc2").hitpoints, 40);
            assert.strictEqual(client2.state.objects.trainingDummies.get("dummy1").hitpoints, 50);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle entity removed from state while still referenced in view", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            const npc = new NpcSchema().assign({ npcId: "npc_1", name: "Goblin", x: 100, y: 100, hitpoints: 50 });
            state.npcs.set("npc1", npc);

            const client1 = createClientWithView(state);
            client1.view.add(npc);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("npc1").name, "Goblin");

            // NPC is removed from state, but the view.remove() for this entity
            // happens AFTER state removal (race condition in spatial update timing)
            state.npcs.delete("npc1");
            encodeMultiple(encoder, state, [client1]);

            // Now view.remove() is called on a detached entity
            client1.view.remove(npc);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("npc1"), undefined);

            // Add a new entity with a different key to ensure encoding is still working
            const npc2 = new NpcSchema().assign({ npcId: "npc_2", name: "Orc", x: 200, y: 200, hitpoints: 80 });
            state.npcs.set("npc2", npc2);
            client1.view.add(npc2);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("npc2").name, "Orc");

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        it("should handle simultaneous state add + view add before any encode", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            // Dynamically add entity to state AND view before encoding
            const dummy = new TrainingDummySchema().assign({ x: 100, y: 100, hitpoints: 100, subtype: "dummy" });
            state.objects.trainingDummies.set("dummy1", dummy);
            client1.view.add(dummy);

            // Also add an NPC at the same time
            const npc = new NpcSchema().assign({ npcId: "npc_1", name: "Guard", x: 100, y: 100, hitpoints: 100 });
            state.npcs.set("npc1", npc);
            client1.view.add(npc);

            // Single encode handles both new entities
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.objects.trainingDummies.get("dummy1").hitpoints, 100);
            assert.strictEqual(client1.state.npcs.get("npc1").name, "Guard");

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        it("should handle NPC with @view() ArraySchema fields entering/leaving view", () => {
            // NPC has @view() fields including ArraySchema children
            class NpcWithArrays extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("boolean") hidden: boolean = false;
                @view() @type("int16") hitpoints: number = 0;
                @view() @type("string") npcId: string = "unknown";
                @view() @type("string") name: string = "Unknown";
                @view() @type(["string"]) appearanceLayers = new ArraySchema<string>();
                @view() @type(["string"]) equipmentLayers = new ArraySchema<string>();
            }

            class GameState extends Schema {
                @type({ map: NpcWithArrays }) npcs = new MapSchema<NpcWithArrays>();
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            // Create NPCs with populated arrays
            const npc1 = new NpcWithArrays().assign({
                x: 100, y: 100, npcId: "goblin_1", name: "Goblin",
                hitpoints: 50, hidden: false,
            });
            npc1.appearanceLayers.push("body_green", "armor_leather");
            npc1.equipmentLayers.push("sword", "shield");
            state.npcs.set("npc1", npc1);

            const npc2 = new NpcWithArrays().assign({
                x: 200, y: 200, npcId: "skeleton_1", name: "Skeleton",
                hitpoints: 30, hidden: false,
            });
            npc2.appearanceLayers.push("body_bone");
            npc2.equipmentLayers.push("rusty_sword");
            state.npcs.set("npc2", npc2);

            const npc3 = new NpcWithArrays().assign({
                x: 300, y: 300, npcId: "dragon_1", name: "Dragon",
                hitpoints: 500, hidden: false,
            });
            npc3.appearanceLayers.push("body_red", "wings");
            state.npcs.set("npc3", npc3);

            // Two clients with different spatial views
            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Initial encode - no views yet
            encodeMultiple(encoder, state, [client1, client2]);

            // Client1 sees npc1 and npc2
            client1.view.add(npc1);
            client1.view.add(npc2);
            // Client2 sees npc2 and npc3
            client2.view.add(npc2);
            client2.view.add(npc3);

            encodeMultiple(encoder, state, [client1, client2]);

            // Client1 should see @view() fields for npc1 and npc2
            assert.strictEqual(client1.state.npcs.get("npc1").name, "Goblin");
            assert.strictEqual(client1.state.npcs.get("npc1").appearanceLayers.length, 2);
            assert.strictEqual(client1.state.npcs.get("npc1").equipmentLayers.length, 2);
            assert.strictEqual(client1.state.npcs.get("npc2").name, "Skeleton");
            assert.strictEqual(client1.state.npcs.get("npc3").name, undefined); // not in view

            // Client2 should see @view() fields for npc2 and npc3
            assert.strictEqual(client2.state.npcs.get("npc1").name, undefined);
            assert.strictEqual(client2.state.npcs.get("npc2").name, "Skeleton");
            assert.strictEqual(client2.state.npcs.get("npc3").name, "Dragon");
            assert.strictEqual(client2.state.npcs.get("npc3").appearanceLayers.length, 2);

            // Simulate movement: npc1 leaves client1's view, npc3 enters
            client1.view.remove(npc1);
            client1.view.add(npc3);

            // Mutate arrays while in view
            npc2.appearanceLayers.push("helmet");
            npc3.equipmentLayers.push("fire_breath");

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("npc1").name, undefined); // removed from view
            assert.strictEqual(client1.state.npcs.get("npc3").name, "Dragon");
            assert.strictEqual(client1.state.npcs.get("npc3").appearanceLayers.length, 2);
            assert.strictEqual(client1.state.npcs.get("npc2").appearanceLayers.length, 2); // helmet added (was 1, now 2)

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should deliver @view() ArraySchema push to existing view (minimal repro)", () => {
            // Minimal reproduction of "refId not found" / missing array push
            class Entity extends Schema {
                @view() @type("string") name: string = "";
                @view() @type(["string"]) items = new ArraySchema<string>();
            }

            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const e1 = new Entity().assign({ name: "one" });
            e1.items.push("a", "b");
            state.entities.set("e1", e1);

            const e2 = new Entity().assign({ name: "two" });
            e2.items.push("x");
            state.entities.set("e2", e2);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // Add both to view
            client.view.add(e1);
            client.view.add(e2);
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").items.length, 2);
            assert.strictEqual(client.state.entities.get("e2").items.length, 1);

            // Remove e1 from view, push to e2's items
            client.view.remove(e1);
            e2.items.push("y");
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").name, undefined);
            assert.strictEqual(client.state.entities.get("e2").items.length, 2);
            assert.strictEqual(client.state.entities.get("e2").items[1], "y");

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("view.remove() should remove @view() ArraySchema children from visible set", () => {
            // Specific bug: view.remove(entity) does not remove child ArraySchema
            // from visible set when entity.isFiltered === false
            class Entity extends Schema {
                @view() @type("string") name: string = "";
                @view() @type(["string"]) items = new ArraySchema<string>();
            }

            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const e1 = new Entity().assign({ name: "one" });
            e1.items.push("a", "b");
            state.entities.set("e1", e1);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            client.view.add(e1);
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").name, "one");
            assert.strictEqual(client.state.entities.get("e1").items.length, 2);

            // Verify e1.items ArraySchema is visible
            assert.ok(client.view.isChangeTreeVisible(e1.items[$changes]),
                "ArraySchema should be visible after view.add(entity)");

            // Remove entity from view
            client.view.remove(e1);

            // BUG: e1.items ArraySchema is still visible after view.remove(entity)
            assert.ok(!client.view.isChangeTreeVisible(e1.items[$changes]),
                "ArraySchema should NOT be visible after view.remove(entity)");

            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.entities.get("e1").name, undefined);

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("should handle dynamic NPC spawn with populated arrays + immediate view add", () => {
            class NpcWithArrays extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("string") npcId: string = "unknown";
                @view() @type(["string"]) layers = new ArraySchema<string>();
            }

            class GameState extends Schema {
                @type({ map: NpcWithArrays }) npcs = new MapSchema<NpcWithArrays>();
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);
            encodeMultiple(encoder, state, [client1]);

            // Dynamically spawn NPC with array data and immediately add to view
            for (let i = 0; i < 10; i++) {
                const npc = new NpcWithArrays().assign({ x: i * 50, y: i * 50, npcId: `npc_${i}` });
                npc.layers.push(`layer_${i}_a`, `layer_${i}_b`);
                state.npcs.set(`npc${i}`, npc);
                client1.view.add(npc);
            }

            encodeMultiple(encoder, state, [client1]);

            for (let i = 0; i < 10; i++) {
                assert.strictEqual(client1.state.npcs.get(`npc${i}`).npcId, `npc_${i}`);
                assert.strictEqual(client1.state.npcs.get(`npc${i}`).layers.length, 2);
            }

            // Remove half from view, spawn new ones
            for (let i = 0; i < 5; i++) {
                client1.view.remove(state.npcs.get(`npc${i}`));
            }
            for (let i = 10; i < 15; i++) {
                const npc = new NpcWithArrays().assign({ x: i * 50, y: i * 50, npcId: `npc_${i}` });
                npc.layers.push(`layer_${i}`);
                state.npcs.set(`npc${i}`, npc);
                client1.view.add(npc);
            }

            encodeMultiple(encoder, state, [client1]);

            // Verify removed ones have undefined @view() fields
            for (let i = 0; i < 5; i++) {
                assert.strictEqual(client1.state.npcs.get(`npc${i}`).npcId, undefined);
            }
            // Verify new ones are visible
            for (let i = 10; i < 15; i++) {
                assert.strictEqual(client1.state.npcs.get(`npc${i}`).npcId, `npc_${i}`);
                assert.strictEqual(client1.state.npcs.get(`npc${i}`).layers.length, 1);
            }

            // Late joining client
            encoder.discardChanges();
            const client2 = createClientWithView(state);
            client2.view.add(state.npcs.get("npc5"));
            client2.view.add(state.npcs.get("npc10"));
            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client2.state.npcs.get("npc5").npcId, `npc_5`);
            assert.strictEqual(client2.state.npcs.get("npc10").npcId, `npc_10`);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle nested WorldObjects container with multiple sub-maps", () => {
            // Nested WorldObjects container pattern
            class TrainDummy extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("int16") hp: number = 0;
                @view() @type("string") subtype: string = "dummy";
            }

            class MiningSpot extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("boolean") depleted: boolean = false;
            }

            class GroundItem extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("string") itemId: string = "";
                @view() @type("string") owner: string = "";
            }

            class WorldObjects extends Schema {
                @type({ map: TrainDummy }) dummies = new MapSchema<TrainDummy>();
                @type({ map: MiningSpot }) mines = new MapSchema<MiningSpot>();
                @type({ map: GroundItem }) groundItems = new MapSchema<GroundItem>();
            }

            class NpcEntity extends Schema {
                @view() @type("uint32") x: number = 0;
                @view() @type("uint32") y: number = 0;
                @view() @type("string") name: string = "";
                @view() @type("int16") hp: number = 0;
            }

            class GameState extends Schema {
                @type({ map: NpcEntity }) npcs = new MapSchema<NpcEntity>();
                @type(WorldObjects) objects = new WorldObjects();
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            // Populate objects across different sub-maps
            for (let i = 0; i < 5; i++) {
                state.objects.dummies.set(`d${i}`, new TrainDummy().assign({ x: i * 100, y: i * 100, hp: 100, subtype: "dummy" }));
                state.objects.mines.set(`m${i}`, new MiningSpot().assign({ x: i * 100 + 50, y: i * 100 + 50 }));
            }
            for (let i = 0; i < 3; i++) {
                state.npcs.set(`npc${i}`, new NpcEntity().assign({ x: i * 100, y: i * 100, name: `NPC ${i}`, hp: 50 }));
            }

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            // Initial encode
            encodeMultiple(encoder, state, [client1, client2]);

            // Simulate spatial proximity: client1 near origin, client2 near x=300
            client1.view.add(state.npcs.get("npc0"));
            client1.view.add(state.objects.dummies.get("d0"));
            client1.view.add(state.objects.mines.get("m0"));

            client2.view.add(state.npcs.get("npc2"));
            client2.view.add(state.objects.dummies.get("d3"));
            client2.view.add(state.objects.mines.get("m3"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.npcs.get("npc0").name, "NPC 0");
            assert.strictEqual(client1.state.objects.dummies.get("d0").hp, 100);
            assert.strictEqual(client1.state.npcs.get("npc2").name, undefined);

            assert.strictEqual(client2.state.npcs.get("npc2").name, "NPC 2");
            assert.strictEqual(client2.state.objects.dummies.get("d3").hp, 100);
            assert.strictEqual(client2.state.npcs.get("npc0").name, undefined);

            // Dynamic: ground item drops near client1
            const loot = new GroundItem().assign({ x: 10, y: 10, itemId: "sword_123", owner: "player1" });
            state.objects.groundItems.set("loot1", loot);
            client1.view.add(loot);

            // Dynamic: training dummy destroyed and replaced
            state.objects.dummies.delete("d0");
            client1.view.remove(state.objects.dummies.get("d0") ?? ({} as any)); // already deleted
            const newDummy = new TrainDummy().assign({ x: 10, y: 10, hp: 100, subtype: "reinforced" });
            state.objects.dummies.set("d0_new", newDummy);
            client1.view.add(newDummy);

            encodeMultiple(encoder, state, [client1, client2]);

            assert.strictEqual(client1.state.objects.groundItems.get("loot1").itemId, "sword_123");
            assert.strictEqual(client1.state.objects.dummies.get("d0_new").hp, 100);

            assertEncodeAllMultiple(encoder, state, [client1, client2]);
        });

        it("should handle replacing entity at same key in MapSchema while in view", () => {
            const state = new RoomState();
            const encoder = getEncoder(state);

            const npc1 = new NpcSchema().assign({ npcId: "npc_1", name: "Goblin", x: 100, y: 100, hitpoints: 50 });
            state.npcs.set("spawn_point_1", npc1);

            const client1 = createClientWithView(state);
            client1.view.add(npc1);
            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("spawn_point_1").name, "Goblin");

            // NPC dies, respawns at same key with new instance
            client1.view.remove(npc1);
            const npc2 = new NpcSchema().assign({ npcId: "npc_1", name: "Goblin", x: 100, y: 100, hitpoints: 50 });
            state.npcs.set("spawn_point_1", npc2); // replace at same key
            client1.view.add(npc2);

            encodeMultiple(encoder, state, [client1]);

            assert.strictEqual(client1.state.npcs.get("spawn_point_1").name, "Goblin");
            assert.strictEqual(client1.state.npcs.get("spawn_point_1").hitpoints, 50);

            assertEncodeAllMultiple(encoder, state, [client1]);
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

        it("removing child from view before removing parent should not break sync", () => {
            class Entity extends Schema {
                @view() @type("string") name: string = "";
                @view() @type(["string"]) items = new ArraySchema<string>();
                @view() @type(["string"]) tags = new ArraySchema<string>();
            }

            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const e1 = new Entity().assign({ name: "one" });
            e1.items.push("a", "b");
            e1.tags.push("x", "y");
            state.entities.set("e1", e1);

            const e2 = new Entity().assign({ name: "two" });
            e2.items.push("c");
            state.entities.set("e2", e2);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // Add both entities to view
            client.view.add(e1);
            client.view.add(e2);
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").items.length, 2);
            assert.strictEqual(client.state.entities.get("e1").tags.length, 2);
            assert.strictEqual(client.state.entities.get("e2").items.length, 1);

            // Remove a child before removing the parent
            client.view.remove(e1.items);
            client.view.remove(e1);

            // Both children should be gone from visible
            assert.ok(!client.view.isVisible(e1.items[$changes]),
                "items should not be visible after remove");
            assert.ok(!client.view.isVisible(e1.tags[$changes]),
                "tags should not be visible after remove");

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").name, undefined);
            assert.strictEqual(client.state.entities.get("e2").items.length, 1);

            // Re-add e1 — should get full state again
            client.view.add(e1);
            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.entities.get("e1").name, "one");
            assert.strictEqual(client.state.entities.get("e1").items.length, 2);
            assert.strictEqual(client.state.entities.get("e1").tags.length, 2);

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("tagged remove() should remove child structures from visible set", () => {
            const TAG_INVENTORY = 1;

            class Player extends Schema {
                @type("string") name: string = "";
                @view(TAG_INVENTORY) @type(["string"]) inventory = new ArraySchema<string>();
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const player = new Player().assign({ name: "Hero" });
            player.inventory.push("sword", "shield", "potion");
            state.players.set("p1", player);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // Add player with inventory tag — adds ArraySchema child to visible
            client.view.add(player, TAG_INVENTORY);

            const inventoryChangeTree = player.inventory[$changes];
            assert.ok(client.view.isVisible(inventoryChangeTree),
                "inventory ChangeTree should be in visible after add");

            // Remove with inventory tag — should remove ArraySchema child from visible
            client.view.remove(player, TAG_INVENTORY);

            assert.ok(!client.view.isVisible(inventoryChangeTree),
                "inventory ChangeTree should NOT be in visible after tagged remove");
        });
    });

    describe("isNew fast path", () => {
        // Regression guard for the StateView._add fast path that skips
        // `view.changes` Map allocations when bootstrapping a fresh
        // (isNew) subtree. Without the fast path each descendant of a
        // freshly-added tree allocates an empty Map in `view.changes`;
        // with it, only the parent collection's entry (seeded by
        // addParentOf) should appear.

        it("view.add(freshPlayer) seeds view.changes only with the parent collection entry", () => {
            class Attribute extends Schema {
                @type("string") name: string;
                @type("number") value: number;
            }
            class Item extends Schema {
                @type("number") price: number;
                @type([Attribute]) attributes = new ArraySchema<Attribute>();
            }
            class Player extends Schema {
                @type("string") name: string;
                @type({ map: Item }) items = new MapSchema<Item>();
            }
            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);
            const client = createClientWithView(state);

            const player = new Player().assign({ name: "p1" });
            for (let k = 0; k < 3; k++) {
                const item = new Item().assign({ price: k });
                for (let l = 0; l < 2; l++) {
                    item.attributes.push(new Attribute().assign({ name: `a${l}`, value: l }));
                }
                player.items.set(`item-${k}`, item);
            }
            state.players.set("p1", player);

            client.view.add(player);

            // Non-filtered ancestors get marked visible by the
            // addParentOf walk to root, but the entry-write is gated on
            // `hasFilteredFields` — `players` (no @view fields) and
            // `state` (no @view fields) are both non-filtered, so the
            // shared encode pass alone is responsible for introducing
            // the player to the decoder. `view.changes` ends up empty
            // for this fast path.
            assert.strictEqual(client.view.changes.size, 0,
                "fast path on a non-filtered chain should write no view.changes entries");

            encodeMultiple(encoder, state, [client]);

            assert.strictEqual(client.state.players.get("p1").name, "p1");
            assert.strictEqual(client.state.players.get("p1").items.size, 3);
            assert.strictEqual(client.state.players.get("p1").items.get("item-0").attributes.length, 2);
            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("fast path gates non-default-tag child schemas behind the correct tag", () => {
            // A @view(TAG) field holding a Schema subtree: default-tag add
            // should NOT mark the tagged child subtree visible. Without the
            // fieldTag filter in _markSubtreeVisible, the tagged subtree
            // would leak into the default-tag view.
            enum Tag { SECRET = 1 }

            class SecretStash extends Schema {
                @type("string") code: string;
            }
            class Player extends Schema {
                @type("string") name: string;
                @view(Tag.SECRET) @type(SecretStash) stash = new SecretStash();
            }
            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const encoder = getEncoder(state);
            const client = createClientWithView(state);

            const player = new Player().assign({ name: "p1" });
            player.stash.code = "xyzzy";
            state.players.set("p1", player);

            client.view.add(player);
            encodeMultiple(encoder, state, [client]);

            const clientPlayer = client.state.players.get("p1");
            assert.strictEqual(clientPlayer.name, "p1");
            assert.strictEqual(clientPlayer.stash?.code, undefined,
                "@view(TAG)-gated subtree should NOT leak through a default-tag add");
            assertEncodeAllMultiple(encoder, state, [client]);
        });
    });

    describe("nested Schema parent visibility (#218)", () => {
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

    describe("view.changes encoding order (refId not found)", () => {
        /**
         * Repro from https://github.com/Gabixel/colyseus-test-stateview-repo
         *
         * Same class of bug as colyseus/colyseus#936: the wire stream
         * SWITCH_TO_STRUCTURE's into a refId before the decoder has been
         * told that refId exists.
         *
         * Here it surfaces purely on the schema side: a Schema instance
         * accumulates several parents (cardHand → pickingCard → publicCards),
         * then `view.remove()` followed by `view.add()` re-runs `addParentOf`
         * and inserts the newly-visible parent entries (publicCards, gameData)
         * into `view.changes` *after* the existing entry for the obj itself.
         * `Encoder.encodeView` iterates the Map in insertion order, so the
         * stream tries to switch to publicCards' refId before gameData's ADD
         * has registered it on the decoder.
         */
        class Card extends Schema {
            @type("string") cardId: string;
        }

        class PlayingUser extends Schema {
            @type("string") playerId: string;
            @view() @type(Card) pickingCard: Card;
            @view() @type([Card]) cardHand = new ArraySchema<Card>();
        }

        class GameData extends Schema {
            @view() @type([Card]) publicCards = new ArraySchema<Card>();
            @type([PlayingUser]) playingUsers = new ArraySchema<PlayingUser>();
        }

        class TestState extends Schema {
            @type(GameData) gameData = new GameData();
        }

        /**
         * Stripped-down variant of the same root cause: the obj's own
         * entry in `view.changes` is created *before* its parent chain
         * has any entries, so when `addParentOf` later inserts the
         * parent entries they land at the tail of the Map and the wire
         * stream tries to switch into the obj before its parent has
         * been introduced.
         *
         * Reproducer: a `view.remove()` on a filtered Schema child
         * (whose immediate parent is another Schema, not a collection,
         * so the remove only writes an entry for the child's refId),
         * followed by `view.add()` on the same child. The subsequent
         * `addParentOf` walk inserts the wrapper's entry *after* the
         * already-existing child entry.
         */
        it("view.remove() + view.add() on a never-visible nested @view Schema should preserve parent-before-child wire order", () => {
            class Child extends Schema {
                @view() @type("string") secret: string = "";
            }

            class Wrapper extends Schema {
                @view() @type(Child) child: Child;
            }

            class State extends Schema {
                @type(Wrapper) wrapper = new Wrapper();
            }

            const state = new State();
            const encoder = getEncoder(state);

            state.wrapper.child = new Child().assign({ secret: "shh" });

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // child is filtered out; the decoder has no record of its refId.
            assert.strictEqual(client.state.wrapper.child, undefined);

            // remove + add on the child without introducing its parent first.
            client.view.remove(state.wrapper.child);
            client.view.add(state.wrapper.child);

            const originalConsoleError = console.error;
            const errors: string[] = [];
            console.error = (...args: any[]) => { errors.push(args.map(String).join(" ")); };
            try {
                encodeMultiple(encoder, state, [client]);
            } finally {
                console.error = originalConsoleError;
            }

            assert.deepStrictEqual(
                errors.filter((line) => line.includes('"refId" not found')),
                [],
                "decoder should not log 'refId not found' for this view encoding",
            );

            assert.strictEqual(client.state.wrapper.child?.secret, "shh");

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("should not emit out-of-order refIds when re-adding a card after pushing it to a view-tagged collection", () => {
            const state = new TestState();
            const encoder = getEncoder(state);

            const client1 = createClientWithView(state);

            // 1. user joins; create their PlayingUser
            const playingUser = new PlayingUser().assign({ playerId: "p1" });
            state.gameData.playingUsers.push(playingUser);
            encodeMultiple(encoder, state, [client1]);

            // 2. deal 5 cards into the player's hand and add each to their view
            for (let i = 0; i < 5; i++) {
                const card = new Card().assign({ cardId: i.toString() });
                playingUser.cardHand.push(card);
                client1.view.add(card);
            }
            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(client1.state.gameData.playingUsers[0].cardHand.length, 5);

            // 3. pick the first card -> assign to pickingCard, remove from hand.
            //    The card now has *two* parents in its parent chain (pickingCard field, cardHand).
            playingUser.pickingCard = playingUser.cardHand[0];
            playingUser.cardHand.shift();
            encodeMultiple(encoder, state, [client1]);
            assert.strictEqual(client1.state.gameData.playingUsers[0].cardHand.length, 4);
            assert.strictEqual(client1.state.gameData.playingUsers[0].pickingCard.cardId, "0");

            // 4. the "quirky" sequence the original repro describes:
            //    push the card to a view-tagged public collection, then
            //    remove + re-add the card to this client's view.
            const card = playingUser.pickingCard;
            state.gameData.publicCards.push(card);
            client1.view.remove(card);
            client1.view.add(card);

            // capture decoder errors — the bug surfaces as `console.error("refId not found: …")`
            // from Decoder.decode, not as a thrown exception.
            const originalConsoleError = console.error;
            const errors: string[] = [];
            console.error = (...args: any[]) => { errors.push(args.map(String).join(" ")); };
            try {
                encodeMultiple(encoder, state, [client1]);
            } finally {
                console.error = originalConsoleError;
            }

            assert.deepStrictEqual(
                errors.filter((line) => line.includes('"refId" not found')),
                [],
                "decoder should not log 'refId not found' for this view encoding",
            );

            // re-adding the card should leave the client's view consistent:
            // the card is visible, and reachable via publicCards now that
            // gameData.publicCards itself is visible to this client.
            assert.strictEqual(client1.state.gameData.publicCards.length, 1);
            assert.strictEqual(client1.state.gameData.publicCards[0].cardId, "0");

            assertEncodeAllMultiple(encoder, state, [client1]);
        });

        //
        // The next three tests are ports of regression tests from
        // colyseus/colyseus#936 (`bundles/colyseus/test/Room.test.ts`).
        // The PR fixed a wire-order bug in SchemaSerializer's
        // getFullState() stitching; the same wire-order class can be
        // exercised at the schema layer to confirm encodeView holds the
        // invariant on its own.
        //

        class FilteredEntity extends Schema {
            @type("string") label: string = "";
            @view() @type("string") note: string = "";
        }

        class PublicNested extends Schema {
            @type("string") mode: string = "";
            @type("uint16") tickCount: number = 0;
        }

        class FilteredState extends Schema {
            @view() @type({ map: FilteredEntity }) entities = new MapSchema<FilteredEntity>();
            @type(PublicNested) nested = new PublicNested();
        }

        it("encodes newly visible filtered structures together with non-@view shared mutations", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // mid-tick: add a new entity, view.add it, mutate non-@view nested
            const entity = new FilteredEntity().assign({ label: "new entity", note: "view scalar" });
            state.entities.set("entity", entity);
            client.view.add(entity);
            state.nested.mode = "shared change";
            state.nested.tickCount++;

            const originalConsoleError = console.error;
            const errors: string[] = [];
            console.error = (...args: any[]) => { errors.push(args.map(String).join(" ")); };
            try {
                encodeMultiple(encoder, state, [client]);
            } finally {
                console.error = originalConsoleError;
            }

            assert.deepStrictEqual(
                errors.filter((line) => line.includes('"refId" not found')),
                [],
                "decoder should not log 'refId not found'",
            );

            assert.strictEqual(client.state.nested.mode, "shared change");
            assert.strictEqual(client.state.nested.tickCount, 1);
            assert.strictEqual(client.state.entities.get("entity")?.label, "new entity");
            assert.strictEqual(client.state.entities.get("entity")?.note, "view scalar");

            assertEncodeAllMultiple(encoder, state, [client]);
        });

        it("preserves @view scalar fields when structural introductions share the same patch", () => {
            const state = new FilteredState();

            // entity exists in state *before* the client bootstraps
            const entity = new FilteredEntity().assign({ label: "existing entity", note: "initial note" });
            state.entities.set("entity", entity);

            const encoder = getEncoder(state);
            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // mid-tick: view.add an existing entity, mutate non-@view nested
            client.view.add(entity);
            state.nested.mode = "shared change";

            const originalConsoleError = console.error;
            const errors: string[] = [];
            console.error = (...args: any[]) => { errors.push(args.map(String).join(" ")); };
            try {
                encodeMultiple(encoder, state, [client]);
            } finally {
                console.error = originalConsoleError;
            }

            assert.deepStrictEqual(
                errors.filter((line) => line.includes('"refId" not found')),
                [],
                "decoder should not log 'refId not found'",
            );

            assert.strictEqual(client.state.nested.mode, "shared change");
            assert.strictEqual(client.state.entities.get("entity")?.label, "existing entity");
            assert.strictEqual(client.state.entities.get("entity")?.note, "initial note");

            assertEncodeAllMultiple(encoder, state, [client]);
        });

    });

});
