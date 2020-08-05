import * as util from "util";
import * as assert from "assert";
import { nanoid } from "nanoid";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Context } from "../src";

import { State, Player } from "./Schema";

describe("Edge cases", () => {
    it("Schema should support up to 64 fields", () => {
        const maxFields = 64;
        class State extends Schema {};

        const schema = {};
        for (let i = 0; i < maxFields; i++) { schema[`field_${i}`] = "string"; }
        defineTypes(State, schema);

        const state = new State();
        for (let i = 0; i < maxFields; i++) { state[`field_${i}`] = "value " + i; }

        const decodedState = Reflection.decode(Reflection.encode(state));
        decodedState.decode(state.encode());

        for (let i = 0; i < maxFields; i++) {
            assert.equal("value " + i, decodedState[`field_${i}`]);
        }
    });

    it("should support more than 255 schema types", () => {
        const maxSchemaTypes = 500;
        const type = Context.create();

        // @type("number") i: number;
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

        const decodedState: State = Reflection.decode(Reflection.encode(state));
        decodedState.decode(state.encode());

        for (let i = 0; i < maxSchemaTypes; i++) {
            assert.equal("value " + i, (decodedState.children[i] as any).str);
        }
    });

    it("NIL check should not collide", () => {
        class State extends Schema {
            @type("int32") num: number;
            @type({ map: "int32" }) mapOfNum = new MapSchema<number>();
            @type(["int32"]) arrayOfNum = new ArraySchema<number>();
        }

        const state = new State();
        state.num = 3519;
        state.mapOfNum['one'] = 3519;
        state.arrayOfNum[0] = 3519;

        const decodedState = new State();
        decodedState.decode(state.encode());

        /**
         * 3520 is encoded as [192, 13, 0, 0]
         * (192 is the NIL byte indicator)
         */
        state.num = 3520;
        state.mapOfNum['one'] = 3520;
        state.arrayOfNum[0] = 3520;

        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.toJSON(), {
            num: 3520,
            mapOfNum: { one: 3520 },
            arrayOfNum: [3520]
        });

        state.num = undefined;
        delete state.mapOfNum['one'];
        state.arrayOfNum.pop();

        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.toJSON(), {
            mapOfNum: {},
            arrayOfNum: []
        });
    });

    it("string: containing specific UTF-8 characters", () => {
        let bytes: number[];

        const state = new State();
        const decodedState = new State();

        state.fieldString = "гхб";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("гхб", decodedState.fieldString);

        state.fieldString = "Пуредоминаце";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("Пуредоминаце", decodedState.fieldString);

        state.fieldString = "未知の選手";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("未知の選手", decodedState.fieldString);

        state.fieldString = "알 수없는 플레이어";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("알 수없는 플레이어", decodedState.fieldString);
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

        assert.equal(JSON.stringify(decodedState1), JSON.stringify(decodedState2));
        assert.equal(JSON.stringify(decodedState2), JSON.stringify(decodedState3));

        decodedState3.decode(state.encode()); // patch existing client.
        assert.equal(JSON.stringify(decodedState3), JSON.stringify(decodedState4));
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

            decodedState.decode(state.encode());

            const onAddCalledFor: string[] = [];
            const onRemovedCalledFor: string[] = [];

            decodedState.entities.onAdd = function(entity, key) {
                onAddCalledFor.push(key);
            };

            decodedState.entities.onRemove = function(entity, key) {
                onRemovedCalledFor.push(key);
            };

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
                        delete state.entities[index];
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
                            assert.equal(i, decodedState.entities.get('item' + i).id);

                        } else if (i >= 20 && i < 70) {
                            expectedOnRemove.push('item' + i);
                            assert.equal(false, decodedState.entities.has('item' + i));
                        }
                    }

                    onAddCalledFor.sort((a,b) => parseInt(a.substr(4)) - parseInt(b.substr(4)));
                    onRemovedCalledFor.sort((a,b) => parseInt(a.substr(4)) - parseInt(b.substr(4)));

                    assert.deepEqual(expectedOnAdd, onAddCalledFor);
                    assert.deepEqual(expectedOnRemove, onRemovedCalledFor);

                    assert.equal(60, decodedState.entities.size);
                    done();
                }, 10);

            }, 10);

        });
    });
});
