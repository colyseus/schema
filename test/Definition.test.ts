import * as assert from "assert";

import { Schema, type, MapSchema, ArraySchema, Reflection } from "../src";
import { schema, defineTypes } from "../src/annotations";
import { assertDeepStrictEqualEncodeAll, createClientWithView, createInstanceFromReflection, encodeMultiple, getDecoder, getEncoder } from "./Schema";
import { $changes, $numFields } from "../src/types/symbols";
import { assertType } from "../src/encoding/assert";

describe("Definition Tests", () => {

    it("private Schema fields should be part of enumerable keys", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            somethingPrivate: number = 10;
        }
        class MySchema extends Schema {
            @type("string") str: string;
            @type({ map: Player }) players = new MapSchema<Player>();
            notSynched: boolean = true;
        }

        const obj = new MySchema();
        obj.players.set('one', new Player());

        assert.deepStrictEqual(Object.keys(obj), ['str', 'players', 'notSynched']);
        assert.deepStrictEqual(Array.from(obj.players.keys()), ['one']);
        assert.deepStrictEqual(Object.keys(obj.players.get('one')), ['x', 'y', 'somethingPrivate']);
    });

    describe("no fields", () => {
        it("should allow a Schema instance with no fields", () => {
            class IDontExist extends Schema { }

            const obj = new IDontExist();
            assert.deepStrictEqual(Object.keys(obj), []);
        });

        it("should allow a MapSchema child with no fields ", () => {
            class Item extends Schema { }

            class State extends Schema {
                @type({ map: Item }) map: MapSchema<Item> = new MapSchema<Item>();
            }

            const state = new State();
            const decodedState = createInstanceFromReflection(state);

            assert.doesNotThrow(() => {
                state.map.set("one", new Item());
                decodedState.decode(state.encodeAll());

                state.map.set("two", new Item());
                decodedState.decode(state.encode());

                assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
            });
        });
    });

    describe("Inheritance", () => {
        it("should use different metadata instances on inheritance", () => {
            class Props extends Schema {
                @type("string") str: string;
            }
            class ExtendedProps extends Props {
                @type("string") id: string;
                @type("string") value: string;
            }
            class State extends Schema {
                @type(Props) props = new Props();
                @type(ExtendedProps) extendedProps = new ExtendedProps();
            }

            assert.ok(Props[Symbol.metadata] !== ExtendedProps[Symbol.metadata]);
            assert.strictEqual(ExtendedProps[Symbol.metadata][0], Props[Symbol.metadata][0]);

            assert.strictEqual("str", ExtendedProps[Symbol.metadata][0].name);
            assert.strictEqual("id", ExtendedProps[Symbol.metadata][1].name);
            assert.strictEqual("value", ExtendedProps[Symbol.metadata][2].name);

            assert.strictEqual(0, Props[Symbol.metadata][$numFields]);
            assert.strictEqual(2, ExtendedProps[Symbol.metadata][$numFields]);

            const state = new State();
            const originalContext = getDecoder(state).context;

            const reflectedState = createInstanceFromReflection(state);
            const reflectedContext = getDecoder(reflectedState).context;

            assert.strictEqual(
                // state.extendedProps -> props.str
                (originalContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][0].index,
                (reflectedContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][0].index
            );

            assert.strictEqual(
                // state.extendedProps -> props.id
                (originalContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][1].index,
                (reflectedContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][1].index
            );

            assert.strictEqual(
                // state.extendedProps -> props.value
                (originalContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][2].index,
                (reflectedContext.types[0][Symbol.metadata][1].type as typeof Schema)[Symbol.metadata][2].index
            );
        });
    });

    describe("defineTypes", () => {
        it("should be equivalent", () => {
            class MyExistingStructure extends Schema {}
            defineTypes(MyExistingStructure, { name: "string" });

            const state = new MyExistingStructure();
            (state as any).name = "hello world!";

            const decodedState = new MyExistingStructure();
            decodedState.decode(state.encode());
            assert.strictEqual((decodedState as any).name, "hello world!");
        });
    });

    describe("define type via 'schema' method", () => {

        it("inheritance / instanceof should work", () => {
            const Entity = schema({
                x: "number",
                y: "number",
            }, 'Entity');

            const WalkableEntity = Entity.extends({
                speed: "number"
            }, 'WalkableEntity');

            const Player = WalkableEntity.extends({
                age: "number",
                name: "string",
            }, 'Player');

            const player = new Player();
            player.x = 10;
            player.y = 20;
            player.speed = 100;
            player.age = 30;
            player.name = "Jake Badlands";

            assert.ok(player instanceof Entity);
            assert.ok(player instanceof WalkableEntity);
            assert.ok(player instanceof Player);

            const decodedPlayer = createInstanceFromReflection(player);
            decodedPlayer.decode(player.encode());

            assert.deepStrictEqual(player.toJSON(), decodedPlayer.toJSON());
        });

        it("should define default values", () => {
            const State = schema({
                number: { type: "number", default: 10  },
                str: { type: "string", default: "Hello world"  },
            });

            const state = new State();
            assert.strictEqual(state.number, 10);
            assert.strictEqual(state.str, "Hello world");
        });

        it("maps and arrays should be able to share base class", () => {
            const Entity = schema({
                x: "number",
                y: "number",
            }, 'Entity');

            const WalkableEntity = Entity.extends({
                speed: "number"
            }, 'WalkableEntity');

            const NPC = WalkableEntity.extends({
                hp: "number"
            }, 'NPC');

            const Player = WalkableEntity.extends({
                age: "number",
                name: "string",
            }, 'Player');

            const State = schema({
                str: "string",
                num: "number",
                number: { type: "number", default: 10  },
                mapOfEntities: { map: Entity, default: new MapSchema() },
                arrayOfEntities: { array: Entity, default: [] },
                entity: Entity,
            }, 'State');

            const state = new State();
            state.str = "Hello world";
            state.num = 100;

            assert.strictEqual(state.number, 10);

            state.mapOfEntities.set('entity', new Entity().assign({ x: 10, y: 20 }));
            state.mapOfEntities.set('walkable', new WalkableEntity().assign({ x: 10, y: 20, speed: 100 }));
            state.mapOfEntities.set('player', new Player().assign({ x: 10, y: 20, speed: 100, age: 30, name: "Jake Badlands" }));
            state.mapOfEntities.set('npc', new NPC().assign({ x: 10, y: 20, speed: 100, hp: 100 }));

            state.arrayOfEntities.push(new Entity().assign({ x: 10, y: 20 }));
            state.arrayOfEntities.push(new WalkableEntity().assign({ x: 10, y: 20, speed: 100 }));
            state.arrayOfEntities.push(new Player().assign({ x: 10, y: 20, speed: 100, age: 30, name: "Jake Badlands" }));
            state.arrayOfEntities.push(new NPC().assign({ x: 10, y: 20, speed: 100, hp: 100 }));

            state.entity = new Entity().assign({ x: 10, y: 20 });
            state.entity = new WalkableEntity().assign({ x: 10, y: 20, speed: 100 });
            state.entity = new NPC().assign({ x: 10, y: 20, speed: 100, hp: 100 });

            const decodedPlayer = createInstanceFromReflection(state);
            decodedPlayer.decode(state.encode());

            assert.deepStrictEqual(state.toJSON(), decodedPlayer.toJSON());
            assertDeepStrictEqualEncodeAll(state);
        });

        it("should allow to define 'view' tags", () => {
            const Entity = schema({
                x: "number",
                y: "number",
            }, 'Entity');

            const State = schema({
                entities: { map: Entity, view: true, default: new MapSchema() },
            });

            const state = new State();
            const encoder = getEncoder(state);

            state.entities.set('one', new Entity().assign({ x: 10, y: 20 }));
            state.entities.set('two', new Entity().assign({ x: 30, y: 40 }));

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);

            client1.view.add(state.entities.get("one"));
            client2.view.add(state.entities.get("two"));

            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.toJSON(), { entities: { one: { x: 10, y: 20 } } });
            assert.deepStrictEqual(client2.state.toJSON(), { entities: { two: { x: 30, y: 40 } } });
        })

        it("default values should be a new instance", () => {
            const Entity = schema({
                x: "number",
                y: "number",
            });

            const State = schema({
                entity1: Entity,
                entity2: { type: Entity },
                map: { map: Entity },
                array1: [Entity],
                array2: { array: Entity },
                default: { type: Entity, default: new Entity() },
                default_undefined: { type: Entity, default: undefined },
                default_null: { type: Entity, default: null },
            });

            const state = new State();
            assert.ok(state.entity1 instanceof Entity);
            assert.ok(state.entity2 instanceof Entity);

            assert.ok(state.map instanceof MapSchema);
            assert.strictEqual(state.map.size, 0);

            assert.ok(state.array1 instanceof ArraySchema);
            assert.strictEqual(state.array1.length, 0);

            assert.ok(state.array2 instanceof ArraySchema);
            assert.strictEqual(state.array2.length, 0);

            const state2 = new State();
            assert.ok(state.entity1 !== state2.entity1);
            assert.ok(state.entity2 !== state2.entity2);
            assert.ok(state.map !== state2.map);
            assert.ok(state.array1 !== state2.array1);
            assert.ok(state.array2 !== state2.array2);
            assert.ok(state.default !== state2.default);
            assert.ok(state.default_undefined === undefined);
            assert.ok(state.default_null === null);
        })

        it("should respect inheritance, including methods and default values", () => {
            let v1this: any = undefined;
            let v2this: any = undefined;
            let v3this: any = undefined;

            const V1 = schema({
                x: { type: "number", default: 10 },
                method1() { return 10; },
                shared() {
                    v1this = this;
                    return 100;
                }
            });
            const V2 = V1.extends({
                y: { type: "number", default: 20 },
                method2() { return this.method1() + 20; },
                shared() {
                    v2this = this;
                    return V1.prototype.shared.call(this) + 100;
                }
            });
            const V3 = V2.extends({
                z: { type: "number", default: 30 },
                method3() { return this.method2() + 30; },
                shared() {
                    v3this = this;
                    return V2.prototype.shared.call(this) + 100;
                }
            });

            const v1 = new V1();
            assert.strictEqual(v1.x, 10);
            assert.strictEqual(v1.method1(), 10);
            assert.strictEqual(v1.shared(), 100);
            assert.ok(v1 instanceof V1);
            assert.ok(v1this instanceof V1);
            assert.ok(!(v1 instanceof V2));
            assert.ok(!(v1 instanceof V3));

            const v2 = new V2();
            assert.strictEqual(v2.x, 10);
            assert.strictEqual(v2.y, 20);
            assert.strictEqual(v2.method1(), 10);
            assert.strictEqual(v2.method2(), 30);
            assert.strictEqual(v2.shared(), 200);
            assert.ok(v2 instanceof V1);
            assert.ok(v2 instanceof V2);
            assert.ok(v2this instanceof V2);
            assert.ok(!(v2 instanceof V3));

            const v3 = new V3();
            assert.strictEqual(v3.x, 10);
            assert.strictEqual(v3.y, 20);
            assert.strictEqual(v3.z, 30);
            assert.strictEqual(v3.method1(), 10);
            assert.strictEqual(v3.method2(), 30);
            assert.strictEqual(v3.method3(), 60);
            assert.strictEqual(v3.shared(), 300);
            assert.ok(v3 instanceof V1);
            assert.ok(v3 instanceof V2);
            assert.ok(v3 instanceof V3);
            assert.ok(v3this instanceof V3);
        });

        it("should allow to define methods", () => {
            const State = schema({
                x: "number",

                methodName() {
                    return 100;
                }
            });

            const state = new State();
            assert.strictEqual(100, state.methodName());

            state.x = 10;

            const decodedState = createInstanceFromReflection(state);

            decodedState.decode(state.encodeAll());
            assert.strictEqual(decodedState.x, 10);
        });

        it("should allow to define a class with a constructor", () => {
            const State = schema({
                x: "number",

                initialize (props: any) {
                    this.x = 10;
                }
            });

            const state = new State();
            assert.strictEqual(state.x, 10);

            // Test with props
            const stateWithProps = new State({ x: 5 });
            assert.strictEqual(stateWithProps.x, 10); // init should override props

            // Test that init receives correct parameters
            let receivedState: any, receivedProps: any;
            const StateWithInitCheck = schema({
                x: "number",
                y: "number",

                initialize (props: any) {
                    receivedState = this;
                    receivedProps = props;
                    this.x = 20;
                    this.y = 30;
                }
            });

            const testState = new StateWithInitCheck({ x: 1, y: 2 });
            assert.strictEqual(receivedState, testState);
            assert.deepStrictEqual(receivedProps, { x: 1, y: 2 });
            assert.strictEqual(testState.x, 20);
            assert.strictEqual(testState.y, 30);
        });

        it("initialize should respect inheritance", () => {
            const V1 = schema({
                x: "number",
                initialize(props: any) {
                    this.x = props.x * 2;
                }
            });

            const V2 = V1.extends({
                y: { type: "number", default: 20 },
                initialize(props: any) {
                    V1.prototype.initialize.call(this, props);
                    this.y = props.y * 2;
                }
            });

            const V3 = V2.extends({
                z: { type: "number", default: 30 },
                initialize(props: any) {
                    V2.prototype.initialize.call(this, props);
                    this.z = props.z * 2;
                }
            });

            const v1 = new V1({ x: 10 });
            assert.strictEqual(v1.x, 20);
            assert.ok(v1 instanceof V1);
            assert.ok(!(v1 instanceof V2));
            assert.ok(!(v1 instanceof V3));

            const v2 = new V2({x: 10, y: 20});
            assert.strictEqual(v2.x, 20);
            assert.strictEqual(v2.y, 40);
            assert.ok(v2 instanceof V1);
            assert.ok(v2 instanceof V2);
            assert.ok(!(v2 instanceof V3));

            const v3 = new V3({x: 10, y: 20, z: 30});
            assert.strictEqual(v3.x, 20);
            assert.strictEqual(v3.y, 40);
            assert.strictEqual(v3.z, 60);
            assert.ok(v3 instanceof V1);
            assert.ok(v3 instanceof V2);
            assert.ok(v3 instanceof V3);
        });

    });

});
