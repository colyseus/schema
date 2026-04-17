import * as assert from "assert";

import { Schema, type, MapSchema, ArraySchema, t } from "../src";
import { schema, SchemaType } from "../src/annotations";
import { assertDeepStrictEqualEncodeAll, createClientWithView, createInstanceFromReflection, encodeMultiple, getDecoder, getEncoder } from "./Schema";
import { $names, $numFields, $types } from "../src/types/symbols";

describe("Definition Tests", () => {

    it("non-tracked fields should be own enumerable keys; tracked fields live on prototype", () => {
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

        // Tracked fields are prototype accessors, not own properties.
        // Only non-tracked own properties appear in Object.keys().
        assert.deepStrictEqual(Object.keys(obj), ['notSynched']);
        assert.deepStrictEqual(Array.from(obj.players.keys()), ['one']);
        assert.deepStrictEqual(Object.keys(obj.players.get('one')), ['somethingPrivate']);
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
            assert.strictEqual(ExtendedProps[Symbol.metadata][$names][0], Props[Symbol.metadata][$names][0]);

            assert.strictEqual("str", ExtendedProps[Symbol.metadata][$names][0]);
            assert.strictEqual("id", ExtendedProps[Symbol.metadata][$names][1]);
            assert.strictEqual("value", ExtendedProps[Symbol.metadata][$names][2]);

            assert.strictEqual(0, Props[Symbol.metadata][$numFields]);
            assert.strictEqual(2, ExtendedProps[Symbol.metadata][$numFields]);

            const state = new State();
            const originalContext = getDecoder(state).context;

            const reflectedState = createInstanceFromReflection(state);
            const reflectedContext = getDecoder(reflectedState).context;

            // SoA: indexes are positions in the parallel `names` array.
            // The legacy `metadata[i].index` was redundant (always equaled
            // `i`), so we just compare names instead.
            assert.strictEqual(
                // state.extendedProps -> props.str
                (originalContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][0],
                (reflectedContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][0]
            );

            assert.strictEqual(
                // state.extendedProps -> props.id
                (originalContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][1],
                (reflectedContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][1]
            );

            assert.strictEqual(
                // state.extendedProps -> props.value
                (originalContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][2],
                (reflectedContext.types[0][Symbol.metadata][$types][1] as typeof Schema)[Symbol.metadata][$names][2]
            );
        });
    });

    describe("defineTypes", () => {
        it("should be equivalent", () => {
            class MyExistingStructure extends Schema {
                @type("string") name: string;
            }

            const state = new MyExistingStructure();
            (state as any).name = "hello world!";

            const decodedState = new MyExistingStructure();
            decodedState.decode(state.encode());
            assert.strictEqual((decodedState as any).name, "hello world!");
        });
    });

    describe("define type via 'schema' method", () => {

        it("should be possible to use definition as type in function parameters", () => {
            const Entity = schema({
                x: t.number(),
                y: t.number(),
            }, 'Entity');
            type Entity = SchemaType<typeof Entity>;

            const WalkableEntity = Entity.extend({
                hp: t.number(),
            }, 'WalkableEntity');
            type WalkableEntity = SchemaType<typeof WalkableEntity>;

            const Player = WalkableEntity.extend({
                age: t.number(),
                name: t.string(),
            }, 'Player');
            type Player = SchemaType<typeof Player>;

            const Enemy = WalkableEntity.extend({
                speed: t.number(),
            }, 'Enemy');
            type Enemy = SchemaType<typeof Enemy>;

            function createEntity(entity: Entity) {
                return entity;
            }

            function createWalkableEntity(entity: WalkableEntity) {
                return entity;
            }

            assert.ok(createEntity(new Entity()) instanceof Entity);
            assert.ok(createEntity(new Player()) instanceof Player);
            assert.ok(createEntity(new Enemy()) instanceof Enemy);

            assert.ok(createWalkableEntity(new WalkableEntity()) instanceof WalkableEntity);
            assert.ok(createWalkableEntity(new Player()) instanceof Player);
            assert.ok(createWalkableEntity(new Enemy()) instanceof Enemy);
        })

        it("inheritance / instanceof should work", () => {
            const Entity = schema({
                x: t.number(),
                y: t.number(),
            }, 'Entity');

            const WalkableEntity = Entity.extend({
                speed: t.number()
            }, 'WalkableEntity');

            const Player = WalkableEntity.extend({
                age: t.number(),
                name: t.string(),
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
                number: t.number().default(10),
                str: t.string().default("Hello world"),
            }, 'State');

            const state = new State();
            assert.strictEqual(state.number, 10);
            assert.strictEqual(state.str, "Hello world");
        });

        it("maps and arrays should be able to share base class", () => {
            const Entity = schema({
                x: t.number(),
                y: t.number(),
            }, 'Entity');

            const WalkableEntity = Entity.extend({
                speed: t.number()
            }, 'WalkableEntity');

            const NPC = WalkableEntity.extend({
                hp: t.number()
            }, 'NPC');

            const Player = WalkableEntity.extend({
                age: t.number(),
                name: t.string(),
            }, 'Player');

            const State = schema({
                str: t.string(),
                num: t.number(),
                number: t.number().default(10),
                mapOfEntities: t.map(Entity),
                arrayOfEntities: t.array(Entity),
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
                x: t.number(),
                y: t.number(),
            }, 'Entity');

            const State = schema({
                entities: t.map(Entity).view(),
            }, 'State');

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
                x: t.number(),
                y: t.number(),
            }, 'Entity');

            const State = schema({
                entity1: Entity,
                entity2: t.ref(Entity),
                map: t.map(Entity),
                array1: t.array(Entity),
                array2: t.array(Entity),
                default: t.ref(Entity).default(new Entity()),
                default_undefined: t.ref(Entity).default(undefined),
                default_null: t.ref(Entity).default(null),
            }, 'State');

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
                x: t.number().default(10),
                method1() { return 10; },
                shared() {
                    v1this = this;
                    return 100;
                }
            }, 'V1');
            const V2 = V1.extend({
                y: t.number().default(20),
                method2() { return this.method1() + 20; },
                shared() {
                    v2this = this;
                    return V1.prototype.shared.call(this) + 100;
                }
            }, 'V2');
            const V3 = V2.extend({
                z: t.number().default(30),
                method3() { return this.method2() + 30; },
                shared() {
                    v3this = this;
                    return V2.prototype.shared.call(this) + 100;
                }
            }, 'V3');

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
                x: t.number(),

                methodName() {
                    return 100;
                }
            }, 'State');

            const state = new State();
            assert.strictEqual(100, state.methodName());

            state.x = 10;

            const decodedState = createInstanceFromReflection(state);

            decodedState.decode(state.encodeAll());
            assert.strictEqual(decodedState.x, 10);
        });

        it("initialize should respect inheritance", () => {
            const V1 = schema({
                x: t.number(),
                method() {
                },
                initialize(props: { x?: number }) {
                    if (props.x !== undefined) {
                        this.x = props.x * 2;
                    }
                }
            }, 'V1');

            const V2 = V1.extend({
                y: t.number().default(20),
                initialize(props: { x?: number, y?: number }) {
                    V1.prototype.initialize.call(this, props);
                    if (props.y !== undefined) {
                        this.y = props.y * 2;
                    }
                }
            }, 'V2');

            const V3 = V2.extend({
                z: t.number().default(30),
                initialize(props: { x?: number, y?: number, z?: number }) {
                    V2.prototype.initialize.call(this, props);
                    if (props.z !== undefined) {
                        this.z = props.z * 2;
                    }
                }
            }, 'V3');

            const v1 = new V1({ x: 10 });
            assert.strictEqual(v1.x, 20);
            assert.ok(v1 instanceof V1);
            assert.ok(!(v1 instanceof V2));
            assert.ok(!(v1 instanceof V3));

            const v2 = new V2({ x: 10, y: 20 });
            assert.strictEqual(v2.x, 20);
            assert.strictEqual(v2.y, 40);
            assert.ok(v2 instanceof V1);
            assert.ok(v2 instanceof V2);
            assert.ok(!(v2 instanceof V3));

            const v3 = new V3({ x: 10, y: 20, z: 30 });
            assert.strictEqual(v3.x, 20);
            assert.strictEqual(v3.y, 40);
            assert.strictEqual(v3.z, 60);
            assert.ok(v3 instanceof V1);
            assert.ok(v3 instanceof V2);
            assert.ok(v3 instanceof V3);
        });

        describe("initialize", () => {
            it("should accept default values", () => {
                const State = schema({
                    x: t.number().default(10),
                    y: t.number(),
                    z: t.number()
                }, 'State');

                const state = new State({ x: 20, y: 30, z: 40 });
                assert.strictEqual(state.x, 20);
                assert.strictEqual(state.y, 30);
                assert.strictEqual(state.z, 40);
            });

            it("should allow to specify or left unspecified the initialize method", () => {
                const NoInit = schema({
                    x: t.number(),
                    initialize() { this.x = 10; }
                }, 'NoInit');

                const noInit = new NoInit();
                assert.strictEqual(noInit.x, 10);

                // @ts-expect-error
                const noInitWithArgs = new NoInit({ x: 10 });

                const WithInit = schema({
                    x: t.number(),
                    initialize(props: { x: number }) {
                        this.x = props.x;
                    }
                }, 'WithInit');
                const WithInitExtend = NoInit.extend({
                    y: t.number(),
                    initialize(props: { y: number }) {
                        NoInit.prototype.initialize.call(this, props);
                        this.y = props.y;
                    }
                }, 'WithInitExtend');

                const withInit = new WithInit({ x: 20 });
                assert.strictEqual(withInit.x, 20);

                // @ts-expect-error
                assert.throws(() => new WithInit());

                const withInitExtend = new WithInitExtend({ y: 20 });
                assert.strictEqual(withInitExtend.y, 20);
                assert.strictEqual(withInitExtend.x, 10);
            });

            it("should allow initialize with a single parameter", () => {
                const InitParams = schema({
                    one: t.number(),
                    initialize(one: number) {
                        this.one = one;
                    }
                }, 'InitParams');

                const initParams = new InitParams(1);
                assert.strictEqual(initParams.one, 1);

                // @ts-expect-error
                new InitParams();
            });

            it("should allow initialize with multiple parameters", () => {
                const InitParams = schema({
                    one: t.number(),
                    two: t.number(),
                    initialize(one: number, two: number) {
                        this.one = one;
                        this.two = two;
                    }
                }, 'InitParams');

                const initParams = new InitParams(1, 2);
                assert.strictEqual(initParams.one, 1);
                assert.strictEqual(initParams.two, 2);

                // @ts-expect-error
                new InitParams();
            });

            it("should infer initialize props by default", () => {
                const Vec3 = schema({
                    x: t.number(),
                    y: t.number(),
                    z: t.number(),
                    initialize(props: any) {
                        this.x = props.x;
                        this.y = props.y;
                        this.z = props.z;
                    }
                }, 'Vec3');

                const vec3 = new Vec3({ x: 1, y: 2, z: 3 });
                assert.strictEqual(vec3.x, 1);
                assert.strictEqual(vec3.y, 2);
                assert.strictEqual(vec3.z, 3);
            });

            it("should allow to define a class with a constructor", () => {
                const State = schema({
                    x: t.number().default(10),

                    initialize (props: { x?: number }) {
                        if (props.x !== undefined) {
                            this.x = props.x;
                        }
                    }
                }, 'State');

                const state = new State({});
                assert.strictEqual(state.x, 10);

                // Test with props
                const stateWithProps = new State({ x: 5 });
                assert.strictEqual(stateWithProps.x, 5);

                // Test that init receives correct parameters
                let receivedState: any, receivedProps: any;
                const StateWithInitCheck = schema({
                    x: t.number(),
                    y: t.number(),

                    initialize (props: { x: number, y: number }) {
                        receivedState = this;
                        receivedProps = props;
                        this.x = props.x;
                        this.y = props.y;
                    }
                }, 'StateWithInitCheck');

                const testState = new StateWithInitCheck({ x: 1, y: 2 });
                assert.strictEqual(receivedState, testState);
                assert.deepStrictEqual(receivedProps, { x: 1, y: 2 });
                assert.strictEqual(testState.x, 1);
                assert.strictEqual(testState.y, 2);
            });

        });

        it("should allow to clone with custom constructor", () => {
            const Entity = schema({
                x: t.number(),
                y: t.number(),
                initialize(props: { complex: { x: number, y: number } }) {
                    this.x = props.complex.x;
                    this.y = props.complex.y;
                }
            }, 'Entity');
            const Player = Entity.extend({
                name: t.string(),
                age: t.number(),
                initialize(props: { complex: { name: string, age: number, x: number, y: number } }) {
                    Entity.prototype.initialize.call(this, props);
                    this.name = props.complex.name;
                    this.age = props.complex.age;
                }
            }, 'Player');
            const State = schema({
                x: t.number(),
                y: t.number(),
                players: t.map(Player),
                initialize(props: { complex: { x: number, y: number } }) {
                    this.x = props.complex.x;
                    this.y = props.complex.y;
                }
            }, 'State');

            const state = new State({ complex: { x: 1, y: 2 } });
            state.players.set('one', new Player({ complex: { name: "John", age: 30, x: 10, y: 20 } }));
            state.players.set('two', new Player({ complex: { name: "Jane", age: 25, x: 30, y: 40 } }));

            const clonedState = state.clone();
            assert.deepStrictEqual(clonedState.toJSON(), state.toJSON());

            const clonedPlayerOne = clonedState.players.get('one');
            assert.ok(clonedPlayerOne instanceof Player);
            assert.ok(clonedPlayerOne instanceof Entity);
            assert.ok(clonedPlayerOne.name === "John");
            assert.ok(clonedPlayerOne.age === 30);
            assert.ok(clonedPlayerOne.x === 10);
            assert.ok(clonedPlayerOne.y === 20);

        });

        it("should not auto-initialize Schema instances", () => {
            const Base = schema({
                value: t.string(),
                initialize(value: { something: string }) {
                    this.value = value.something;
                },
            }, 'Base');

            const Child = schema({
                world: t.string(),
                random: Base,
                initialize(world: string) {
                    this.world = world;
                },
            }, 'Child');

            assert.doesNotThrow(() => {
                new Child('hello');
            });
        });

        it("should exclude parent props from initialize method (1)", () => {
            const StatSchema = schema({
                value: t.number(),
                initialize(value: number) {
                    this.value = value;
                },
            }, 'StatSchema');

            const EntitySchema = schema({
                id: t.string(),
                initialize({ id }: any) {
                    this.id = id;
                },
            }, 'EntitySchema');

            const LivingEntitySchema = EntitySchema.extend({
                stats: t.map(StatSchema),
                initialize(props: any) {
                    EntitySchema.prototype.initialize.call(this, props);

                    for (const [key, value] of Object.entries(props.stats)) {
                        this.stats.set(key, new StatSchema(value as number));
                    }
                },
            }, 'LivingEntitySchema');

            const entity = new LivingEntitySchema({
                id: '123',
                stats: { hp: 500, },
            });

            assert.strictEqual(entity.id, '123');
            assert.strictEqual(entity.stats.get('hp')?.value, 500);
        });

        it("should auto-initialize Schema instances with default values", () => {
            const AnotherRandomSchema = schema({
                value: t.string().default('world'),
            }, 'AnotherRandomSchema');

            const RandomSchema = schema({
                value: t.string().default('hello'),
                anotherRandom: AnotherRandomSchema,
            }, 'RandomSchema');

            const StatSchema = schema({
                value: t.number(),
                random: RandomSchema,
                initialize(value: number) {
                    this.value = value;
                },
            }, 'StatSchema');

            assert.doesNotThrow(() => {
                const entity = new StatSchema(5);
                assert.strictEqual(entity.value, 5);
                assert.strictEqual(entity.random.value, 'hello');
                assert.strictEqual(entity.random.anotherRandom.value, 'world');

            })
        })

        describe("extends", () => {
            it("should not call initialize automatically when creating an instance of inherited Schema (1)", () => {
                let childSchemaInitializeCallCount = 0;

                const ChildSchema = schema({
                    name: t.string(),
                    initialize(props: { name: string }) {
                        this.name = props.name;
                        childSchemaInitializeCallCount++;
                    },
                }, 'ChildSchema');

                const ParentSchema = ChildSchema.extend({
                    id: t.string(),
                    initialize(props: { id: string }) {
                        ChildSchema.prototype.initialize.call(this, {
                            name: 'Jim',
                        });
                        this.id = props.id;
                    },
                }, 'ParentSchema');

                assert.doesNotThrow(() => {
                    const parent = new ParentSchema({ id: 'parent' });
                    assert.strictEqual(parent.id, 'parent');
                    assert.strictEqual(parent.name, 'Jim');
                });

                assert.strictEqual(childSchemaInitializeCallCount, 1);
            })

            it("should not call initialize automatically when creating an instance of inherited Schema (2)", () => {
                const EntitySchema = schema({
                    id: t.string(),
                    name: t.string(),
                    initialize(props: { id: string; name: string }) {
                        this.id = props.id;
                        this.name = props.name;
                    },
                }, 'EntitySchema');

                const PlayerSchema = EntitySchema.extend({
                    initialize(props: any) {
                        EntitySchema.prototype.initialize.call(this, {
                            id: props.public_id,
                            name: props.username,
                        });
                    },
                }, 'PlayerSchema');

                const player = new EntitySchema({ id: '1', name: 'test' });
                assert.strictEqual(player.id, '1');
                assert.strictEqual(player.name, 'test');

                assert.doesNotThrow(() => {
                    const player = new PlayerSchema({ id: 1, public_id: '1', username: 'test' });
                    assert.strictEqual(player.id, '1');
                    assert.strictEqual(player.name, 'test');
                });
            });

        });

        it("should allow to define a field as not synced", () => {
            // NOTE: `sync: false` has no direct builder equivalent; field dropped from schema definition.
            const State = schema({
                x: t.number().default(10),
                y: t.number().default(20),
            }, 'State');

            const state = new State();
            (state as any).privateField = 30;
            assert.strictEqual(state.x, 10);
            assert.strictEqual(state.y, 20);
            assert.strictEqual((state as any).privateField, 30);

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encodeAll());
            assert.strictEqual(decodedState.x, 10);
            assert.strictEqual(decodedState.y, 20);
            assert.strictEqual((decodedState as any).privateField, undefined);
        });

    });

});
