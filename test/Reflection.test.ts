import * as util from "util";
import * as assert from "assert";
import { Reflection, Schema, type, MapSchema, ArraySchema, $changes, TypeContext, Decoder, entity } from "../src";
import { createInstanceFromReflection, getEncoder } from "./Schema";
import { Reflection } from "../src/Reflection";

/**
 * No filters example
 */
class Player extends Schema {
  @type("string") name: string;
  @type("number") x: number;
  @type("number") y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Schema {
  @type('string') fieldString: string;
  @type('number') fieldNumber: number;
  @type(Player) player: Player;
  @type([ Player ]) arrayOfPlayers: ArraySchema<Player>;
  @type({ map: Player }) mapOfPlayers: MapSchema<Player>;
}

describe("Reflection", () => {

    it("should allow to encode and decode empty structures", () => {
        class EmptyState extends Schema {}
        const state = new EmptyState();

        const reflected = new Reflection();
        const encoder = getEncoder(state);

        const encoded = Reflection.encode(encoder);
        console.log(Array.from(encoded));

        reflected.decode(encoded);
        assert.strictEqual(reflected.types.length, 1);
    });

    it("should encode schema definitions", () => {
        const state = new State();

        const reflected = new Reflection();
        reflected.decode(Reflection.encode(getEncoder(state)));

        assert.deepStrictEqual(
            reflected.toJSON(),
            {
                types: [
                    {
                        id: 0,
                        fields: [
                            { name: 'fieldString', type: 'string' },
                            { name: 'fieldNumber', type: 'number' },
                            { name: 'player', type: 'ref', referencedType: 1 },
                            { name: 'arrayOfPlayers', type: 'array', referencedType: 1 },
                            { name: 'mapOfPlayers', type: 'map', referencedType: 1 }
                        ]
                    },
                    {
                        id: 1,
                        fields: [
                            { name: 'name', type: 'string' },
                            { name: 'x', type: 'number' },
                            { name: 'y', type: 'number' }
                        ]
                    }
                ]
            }
        );
    });

    it("reflected fields must initialize as undefined", () => {
        const state = new State();
        const stateReflected = createInstanceFromReflection(state);

        assert.strictEqual(stateReflected.arrayOfPlayers, undefined);
        assert.strictEqual(stateReflected.mapOfPlayers, undefined);
        assert.strictEqual(stateReflected.player, undefined);
        assert.strictEqual(stateReflected.fieldNumber, undefined);
        assert.strictEqual(stateReflected.fieldString, undefined);
    });

    it("should decode schema and be able to use it", () => {
        const state = new State();
        const stateReflected = createInstanceFromReflection(state);

        state.fieldString = "Hello world!";
        state.fieldNumber = 10;
        state.player = new Player("directly referenced player", 1, 1);
        state.mapOfPlayers = new MapSchema({
            'one': new Player("player one", 2, 2),
            'two': new Player("player two", 3, 3)
        })
        state.arrayOfPlayers = new ArraySchema(new Player("in array", 4, 4));

        stateReflected.decode(state.encode());

        assert.strictEqual(stateReflected.fieldString, "Hello world!");
        assert.strictEqual(stateReflected.fieldNumber, 10);

        assert.strictEqual(stateReflected.player.name, "directly referenced player");
        assert.strictEqual(stateReflected.player.x, 1);
        assert.strictEqual(stateReflected.player.y, 1);

        assert.strictEqual(Array.from(stateReflected.mapOfPlayers.keys()).length, 2);
        assert.strictEqual(stateReflected.mapOfPlayers.get('one').name, "player one");
        assert.strictEqual(stateReflected.mapOfPlayers.get('one').x, 2);
        assert.strictEqual(stateReflected.mapOfPlayers.get('one').y, 2);
        assert.strictEqual(stateReflected.mapOfPlayers.get('two').name, "player two");
        assert.strictEqual(stateReflected.mapOfPlayers.get('two').x, 3);
        assert.strictEqual(stateReflected.mapOfPlayers.get('two').y, 3);

        assert.strictEqual(stateReflected.arrayOfPlayers.length, 1);
        assert.strictEqual(stateReflected.arrayOfPlayers[0].name, "in array");
        assert.strictEqual(stateReflected.arrayOfPlayers[0].x, 4);
        assert.strictEqual(stateReflected.arrayOfPlayers[0].y, 4);
    });

    it("should support inheritance", () => {
        class Point extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }

        class Player extends Point {
            @type("string") name: string;
        }

        class MyState extends Schema {
            @type([Point]) points = new ArraySchema<Point>();
            @type([Player]) players = new ArraySchema<Player>();
        }

        const reflected = new Reflection();
        const encoded = Reflection.encode(getEncoder(new MyState()));
        reflected.decode(encoded)

        assert.deepStrictEqual(reflected.toJSON(), {
            types: [
                {
                    id: 0,
                    fields: [
                        { name: 'points', type: 'array', referencedType: 1 },
                        { name: 'players', type: 'array', referencedType: 2 }
                    ]
                },
                {
                    id: 1,
                    fields: [
                        { name: 'x', type: 'number' },
                        { name: 'y', type: 'number' },
                    ]
                },
                {
                    id: 2,
                    extendsId: 1,
                    fields: [
                        { name: 'name', type: 'string' }
                    ]
                }
            ]
        });
    });

    it("should reflect map of primitive type", () => {
        class MyState extends Schema {
            @type({ map: "string" })
            mapOfStrings: MapSchema<string> = new MapSchema();
        }

        const state = new MyState();
        const decodedState = createInstanceFromReflection(state);

        state.mapOfStrings.set('one', "one");
        state.mapOfStrings.set('two', "two");
        decodedState.decode(state.encode());

        assert.strictEqual(JSON.stringify(decodedState), '{"mapOfStrings":{"one":"one","two":"two"}}');
    });

    it("should reflect array of primitive type", () => {
        class MyState extends Schema {
            @type([ "string" ])
            arrayOfStrings: ArraySchema<string> = new ArraySchema();
        }

        const state = new MyState();
        const decodedState = createInstanceFromReflection(state);

        state.arrayOfStrings.push("one")
        state.arrayOfStrings.push("two");
        decodedState.decode(state.encode());

        assert.strictEqual(JSON.stringify(decodedState), '{"arrayOfStrings":["one","two"]}');
    });

    it("should reflect and be able to use multiple structures of primitive tyes", () => {
        class MyState extends Schema {
            @type("string") currentTurn: string;
            @type({ map: "number" }) players: MapSchema<number>;
            @type(["number"]) board: ArraySchema<number>;
            @type("string") winner: string;
            @type("boolean") draw: boolean;
        }

        const state = new MyState();
        state.currentTurn = "one";
        state.players = new MapSchema();
        state.board = new ArraySchema(0, 0, 0, 0, 0, 0, 0, 0, 0);
        state.players.set('one', 1);

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        const decodedState2 = createInstanceFromReflection(state);
        decodedState2.decode(state.encodeAll());

        assert.strictEqual(JSON.stringify(decodedState), '{"currentTurn":"one","players":{"one":1},"board":[0,0,0,0,0,0,0,0,0]}');
        assert.strictEqual(JSON.stringify(decodedState2), '{"currentTurn":"one","players":{"one":1},"board":[0,0,0,0,0,0,0,0,0]}');
    });

    it("should support an inheritance with a Schema type without fields", () => {
        abstract class Component extends Schema {}
        class MyComponent extends Component {
            @type("number") num: number = Math.random();
        }

        class State extends Schema {
            @type({ map: Component }) components = new Map<string, Component>();
        }

        const state = new State();
        state.components.set("one", new MyComponent());
        state.components.set("two", new MyComponent());

        const decodedState = createInstanceFromReflection(state);
        assert.doesNotThrow(() => decodedState.decode(state.encode()));
    });

    it("should allow to be re-constructed from previous reflected state", () => {
        const state = new State();
        state.fieldString = "Hello world!";
        state.fieldNumber = 100;
        state.player = new Player().assign({ name: "p1", x: 1, y: 2 });
        state.arrayOfPlayers = new ArraySchema();
        state.arrayOfPlayers.push(new Player().assign({ name: "p2", x: 3, y: 4 }));
        state.mapOfPlayers = new MapSchema();
        state.mapOfPlayers.set("one", new Player().assign({ name: "p2", x: 3, y: 4 }));
        const encoded = state.encodeAll();

        const reflected1 = createInstanceFromReflection(state);
        const reflected2 = createInstanceFromReflection(reflected1);
        const reflected3 = createInstanceFromReflection(reflected2);
        const reflected4 = createInstanceFromReflection(reflected3);

        reflected1.decode(encoded);
        reflected2.decode(encoded);
        reflected3.decode(encoded);
        reflected4.decode(encoded);

        assert.deepStrictEqual(state.toJSON(), reflected1.toJSON());
        assert.deepStrictEqual(state.toJSON(), reflected2.toJSON());
        assert.deepStrictEqual(state.toJSON(), reflected3.toJSON());
        assert.deepStrictEqual(state.toJSON(), reflected4.toJSON());
    });

    it("order of decoded types must follow inheritance order", () => {
        class Vector2D extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class Health extends Schema {
            @type("number") max: number;
            @type("number") current: number;
        }
        class Entity extends Schema {
            @type("string") uuid: string;
            @type(Vector2D) position = new Vector2D();
        }
        class DynamicEntity extends Entity {
            @type(Health) health = new Health();
        }
        class Player extends DynamicEntity {
            @type("string") name: string;
        }

        @entity class SlimeEntity extends DynamicEntity { }

        abstract class EntitiesMap<T extends Entity = Entity> extends Schema {
            @type({ map: Entity }) entities = new MapSchema<T>();
        }

        class StaticEntitiesMap extends EntitiesMap {}
        class DynamicEntitiesMap<T extends DynamicEntity = DynamicEntity> extends EntitiesMap<T> {}
        class PlayerMap extends DynamicEntitiesMap<Player> {}

        class State extends Schema {
            @type(StaticEntitiesMap) staticEntities = new StaticEntitiesMap();
            @type(DynamicEntitiesMap) dynamicEntities = new DynamicEntitiesMap();
            @type(PlayerMap) players = new PlayerMap();
        }

        const state = new State();
        const encoded = Reflection.encode(getEncoder(state));

        const reflected = new Reflection();
        const decoder = new Decoder(reflected);
        decoder.decode(encoded);

        const types = reflected.types;
        assert.strictEqual(11, types.length)

        const addedTypeIds = new Set<number>();

        types.forEach((type) => {
            addedTypeIds.add(type.id);

            if (type.extendsId !== undefined) {
                assert.ok(addedTypeIds.has(type.extendsId), "Base type must be added before its children");
            }
        });
    });
});