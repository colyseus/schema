import * as util from "util";
import * as assert from "assert";
import { nanoid } from "nanoid";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes, entity } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder } from "./Schema";

describe("Edge cases", () => {
    it("Schema should support up to 64 fields", () => {
        const maxFields = 64;
        class State extends Schema {};

        const schema = {};
        for (let i = 0; i < maxFields; i++) { schema[`field_${i}`] = "string"; }
        defineTypes(State, schema);

        const state = new State();
        for (let i = 0; i < maxFields; i++) { state[`field_${i}`] = "value " + i; }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        for (let i = 0; i < maxFields; i++) {
            assert.strictEqual("value " + i, decodedState[`field_${i}`]);
        }

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should support more than 255 schema types", () => {
        Encoder.BUFFER_SIZE = 32 * 1024;

        const maxSchemaTypes = 500;

        class Base extends Schema { }
        class State extends Schema {
            @type([Base]) children = new ArraySchema<Base>();
        }

        const schemas: any = {};

        for (let i = 0; i < maxSchemaTypes; i++) {
            class Child extends Base {
                @type("string") str: string;
            };
            schemas[i] = Child;
        }

        const state = new State();
        for (let i = 0; i < maxSchemaTypes; i++) {
            const child = new schemas[i]();
            child.str = "value " + i;
            state.children.push(child);
        }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        for (let i = 0; i < maxSchemaTypes; i++) {
            assert.strictEqual("value " + i, (decodedState.children[i] as any).str);
        }

        // assertDeepStrictEqualEncodeAll(state);
    });

    describe("max fields limitations", () => {
        class Child extends Schema {
            @type("number") n: number;
        }

        class State extends Schema {
            @type(["number"]) arrayOfNum = new ArraySchema<number>();
            @type(Child) child = new Child();
            @type({ map: "number" }) mapOfNum = new MapSchema<number>();
            @type(Child) child4 = new Child();
            @type(Child) child5 = new Child();
            @type(Child) child6 = new Child();
            @type(Child) child7 = new Child();
            @type(Child) child8 = new Child();
            @type(Child) child9 = new Child();
            @type(Child) child10 = new Child();
            @type(Child) child11 = new Child();
            @type(Child) child12 = new Child();
            @type(Child) child13 = new Child();
            @type(Child) child14 = new Child();
            @type(Child) child15 = new Child();
            @type(Child) child16 = new Child();
            @type(Child) child17 = new Child();
            @type(Child) child18 = new Child();
            @type(Child) child19 = new Child();
            @type(Child) child20 = new Child();
            @type(Child) child21 = new Child();
            @type(Child) child22 = new Child();
            @type(Child) child23 = new Child();
            @type(Child) child24 = new Child();
            @type(Child) child25 = new Child();
            @type(Child) child26 = new Child();
            @type(Child) child27 = new Child();
            @type(Child) child28 = new Child();
            @type(Child) child29 = new Child();
            @type(Child) child30 = new Child();
            @type(Child) child31 = new Child();
            @type(Child) child32 = new Child();
            @type(Child) child33 = new Child();
            @type(Child) child34 = new Child();
            @type(Child) child35 = new Child();
            @type(Child) child36 = new Child();
            @type(Child) child37 = new Child();
            @type(Child) child38 = new Child();
            @type(Child) child39 = new Child();
            @type(Child) child40 = new Child();
            @type(Child) child41 = new Child();
            @type(Child) child42 = new Child();
            @type(Child) child43 = new Child();
            @type(Child) child44 = new Child();
            @type(Child) child45 = new Child();
            @type(Child) child46 = new Child();
            @type(Child) child47 = new Child();
            @type(Child) child48 = new Child();
            @type(Child) child49 = new Child();
            @type(Child) child50 = new Child();
            @type(Child) child51 = new Child();
            @type(Child) child52 = new Child();
            @type(Child) child53 = new Child();
            @type(Child) child54 = new Child();
            @type(Child) child55 = new Child();
            @type(Child) child56 = new Child();
            @type(Child) child57 = new Child();
            @type(Child) child58 = new Child();
            @type(Child) child59 = new Child();
            @type(Child) child60 = new Child();
            @type(Child) child61 = new Child();
            @type(Child) child62 = new Child();
            @type(Child) child63 = new Child();
            @type(Child) child64 = new Child();
        }

        it("SWITCH_TO_STRUCTURE check should not collide", () => {
            //
            // The SWITCH_TO_STRUCTURE byte is `193`
            //

            const numItems = 100;
            const state = new State();
            for (let i = 0; i < numItems; i++) { state.arrayOfNum.push(i); }
            for (let i = 0; i < numItems; i++) { state.mapOfNum.set(i.toString(), i); }

            state.child.n = 0;
            state.child64.n = 0;

            const decodedState = new State();
            decodedState.decode(state.encode());

            state.child = undefined;
            state.child = new Child();
            state.child.n = 1;

            for (let i = 0; i < numItems; i++) {
                state.arrayOfNum[i] = undefined;
                state.arrayOfNum[i] = i * 100;
            }

            for (let i = 0; i < numItems; i++) {
                state.mapOfNum.delete(i.toString());
                state.mapOfNum.set(i.toString(), i * 100);
            }

            const encoded = state.encode();
            decodedState.decode(encoded);

            state.arrayOfNum.clear();
            state.arrayOfNum.push(10);
            console.log(".push() =>", state.arrayOfNum[$changes].indexedOperations);

            state.mapOfNum.clear();
            state.mapOfNum.set("one", 10);

            console.log("\n\nLAST ENCODE:\n\n");

            decodedState.decode(state.encode());
            assert.strictEqual(10, decodedState.arrayOfNum[0]);

            assertDeepStrictEqualEncodeAll(state);
        });

        xit("SWITCH_TO_STRUCTURE should not conflict with `DELETE_AND_ADD` on fieldIndex = 63", () => {
            //
            // FIXME: this should not throw an error.
            // SWITCH_TO_STRUCTURE conflicts with `DELETE_AND_ADD` + fieldIndex = 63
            //
            const state = new State();
            state.child64 = undefined;
            state.child64 = new Child();
            state.child64.n = 1;

            const decodedState = new State();
            decodedState.decode(state.encode());

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    it("string: containing specific UTF-8 characters", () => {
        let bytes: Buffer;

        const state = new State();
        const decodedState = new State();

        state.fieldString = "гхб";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.strictEqual("гхб", decodedState.fieldString);

        state.fieldString = "Пуредоминаце";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.strictEqual("Пуредоминаце", decodedState.fieldString);

        state.fieldString = "未知の選手";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.strictEqual("未知の選手", decodedState.fieldString);

        state.fieldString = "알 수없는 플레이어";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.strictEqual("알 수없는 플레이어", decodedState.fieldString);
    });

    it("MapSchema: index with high number of items should be preserved", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();

        state.encodeAll(); // new client joining

        let i = 0;

        const decodedState1 = new State();
        decodedState1.decode(state.encodeAll()); // new client joining
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

        const decodedState2 = new State();
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
        decodedState2.decode(state.encodeAll()); // new client joining

        const decodedState3 = new State();
        decodedState3.decode(state.encodeAll()); // new client joining
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

        const encoded = state.encode(); // patch state
        decodedState1.decode(encoded);
        decodedState2.decode(encoded);
        decodedState3.decode(encoded);

        const decodedState4 = new State();
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
        decodedState4.decode(state.encodeAll()); // new client joining

        assert.strictEqual(JSON.stringify(decodedState1), JSON.stringify(decodedState2));
        assert.strictEqual(JSON.stringify(decodedState2), JSON.stringify(decodedState3));

        decodedState3.decode(state.encode()); // patch existing client.
        assert.strictEqual(JSON.stringify(decodedState3), JSON.stringify(decodedState4));

        assertDeepStrictEqualEncodeAll(state);
    });

    it("DELETE_AND_ADD unintentionally dropping refId's", () => {
        class TileStatusSchema extends Schema {
            @type("string") state: string;
        }

        class MapTileSchema extends Schema {
            @type("string") id: string;
            //
            // this null assignment used to cause a DELETE_AND_ADD operation.
            // the refId of the TileStatusSchema used to get garbage collected due to refCount = 0.
            //
            @type(TileStatusSchema) status: TileStatusSchema = null;
        }

        class State extends Schema {
            @type({ map: MapTileSchema }) tiles = new MapSchema<MapTileSchema>();
        }

        const state = new State();
        const decodeState = new State()

        function getNewTiles(num): MapTileSchema[] {
            const tiles: MapTileSchema[] = [];
            for (let i=0; i<num; i++) {
                tiles.push(new MapTileSchema().assign({
                    id: "s" + Math.random().toString().split(".")[1],
                    status: new TileStatusSchema().assign({ state: "IDLE" })
                }));
            }
            return tiles;
        }

        function mutateRandom() {
            const keys = Array.from(state.tiles.keys());
            const randTile = keys[Math.floor(Math.random() * keys.length)];
            state.tiles.get(randTile).status.state = Math.random().toString();
        }

        function addTiles(tiles: MapTileSchema[]) {
            tiles.forEach(tile => state.tiles.set(tile.id, tile));
        }

        addTiles(getNewTiles(30));
        decodeState.decode(state.encodeAll());

        for (let i=0;i<10; i++) {
            addTiles(getNewTiles(2));
            decodeState.decode(state.encode());

            mutateRandom();
            decodeState.decode(state.encode());
        }

        assertDeepStrictEqualEncodeAll(state);
    });

    it("replacing initial 'slot' should not throw decoding error", () => {
        class Entity extends Schema {
            @type("string") id = Math.random().toString();
        }

        @entity class EmptySlot extends Entity { }

        class ItemIcon extends Entity {
            @type("string") src = "";
        }

        class ItemAppearance extends Entity {
            @type(ItemIcon) image = new ItemIcon();
        }

        class Equipment extends Entity {
            @type(Entity) slot: EmptySlot | ItemAppearance = new EmptySlot();
        }

        class Player extends Entity {
            @type(Equipment) gear = new Equipment()
            @type([ItemAppearance]) backpack = new ArraySchema<ItemAppearance>();
        }

        class World extends Schema {
            @type([Entity]) entities = new ArraySchema<Entity>()
        }

        class MyRoomState extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>()
            @type(World) world = new World()
        }

        function populateBackpack(player: Player) {
            for (let i = 0; i < 4; i++) {
                const item = new ItemAppearance()
                item.image.src = "https://fastly.picsum.photos/id/537/200/200.jpg"
                player.backpack.push(item)
            }
            player.gear.slot = player.backpack.at(0)
        }

        const state = new MyRoomState();
        const encoder = getEncoder(state);

        const player1 = new Player();
        state.players.set("player1", player1);

        state.world.entities.push(player1);
        const decodedState1 = createInstanceFromReflection(state);
        decodedState1.decode(state.encodeAll());

        assertDeepStrictEqualEncodeAll(state, false);

        populateBackpack(player1);
        decodedState1.decode(state.encode());

        assertDeepStrictEqualEncodeAll(state, false);
    });

    describe("concurrency", () => {
        it("MapSchema should support concurrent actions", (done) => {
            class Entity extends Schema {
                @type("number") id: number;
            }
            class Enemy extends Entity {
                @type("number") level: number;
            }
            class State extends Schema {
                @type({map: Entity}) entities = new MapSchema<Entity>();
            }

            function createEnemy(i: number) {
                return new Enemy().assign({
                    id: i,
                    level: i * 100,
                });
            }

            const state = new State();
            const decodedState = new State();

            const $ = getCallbacks(decodedState);

            decodedState.decode(state.encode());

            const onAddCalledFor: string[] = [];
            const onRemovedCalledFor: string[] = [];

            $(decodedState).entities.onAdd((entity, key) =>
                onAddCalledFor.push(key));

            $(decodedState).entities.onRemove((entity, key) =>
                onRemovedCalledFor.push(key));

            // insert 100 items.
            for (let i = 0; i < 100; i++) {
                setTimeout(() => {
                    state.entities.set("item" + i, createEnemy(i));
                }, Math.floor(Math.random() * 10));
            }

            //
            // after all 100 items are added. remove half of them in the same
            // pace
            //
            setTimeout(() => {
                decodedState.decode(state.encode());

                const removedIndexes: string[] = [];
                const addedIndexes: string[] = [];

                for (let i = 20; i < 70; i++) {
                    setTimeout(() => {
                        const index = 'item' + i;
                        removedIndexes.push(index);
                        state.entities.delete(index);
                    }, Math.floor(Math.random() * 10));
                }

                for (let i = 100; i < 110; i++) {
                    setTimeout(() => {
                        const index = 'item' + i;
                        addedIndexes.push(index);
                        state.entities.set(index, createEnemy(i));
                    }, Math.floor(Math.random() * 10));
                }

                setTimeout(() => {
                    decodedState.decode(state.encode());
                }, 5);

                setTimeout(() => {
                    decodedState.decode(state.encode());

                    const expectedOnAdd: string[] = [];
                    const expectedOnRemove: string[] = [];

                    for (let i = 0; i < 110; i++) {
                        expectedOnAdd.push('item' + i);

                        if (i < 20 || i > 70) {
                            assert.strictEqual(i, decodedState.entities.get('item' + i).id);

                        } else if (i >= 20 && i < 70) {
                            expectedOnRemove.push('item' + i);
                            assert.strictEqual(false, decodedState.entities.has('item' + i));
                        }
                    }

                    onAddCalledFor.sort((a,b) => parseInt(a.substring(4)) - parseInt(b.substring(4)));
                    onRemovedCalledFor.sort((a,b) => parseInt(a.substring(4)) - parseInt(b.substring(4)));

                    assert.deepStrictEqual(expectedOnAdd, onAddCalledFor);
                    assert.deepStrictEqual(expectedOnRemove, onRemovedCalledFor);

                    assert.strictEqual(60, decodedState.entities.size);
                    done();
                }, 10);

            }, 10);

        });
    });

});
