import * as assert from "assert";
import { Reflection, Schema, type, MapSchema, ArraySchema, Context } from "../src";

const testContext = new Context();

/**
 * No filters example
 */
class Player extends Schema {
  @type("string", testContext) name: string;
  @type("number", testContext) x: number;
  @type("number", testContext) y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Schema {
  @type('string', testContext) fieldString: string;
  @type('number', testContext) fieldNumber: number;
  @type(Player, testContext) player: Player;
  @type([ Player ], testContext) arrayOfPlayers: ArraySchema<Player>;
  @type({ map: Player }, testContext) mapOfPlayers: MapSchema<Player>;
}

describe("Reflection", () => {

    it("should encode schema definitions", () => {
        const state = new State();

        const reflected = new Reflection();
        reflected.decode(Reflection.encode(state));

        assert.strictEqual(
            JSON.stringify(reflected),
            '{"types":[{"id":0,"fields":[{"name":"name","type":"string"},{"name":"x","type":"number"},{"name":"y","type":"number"}]},{"id":1,"fields":[{"name":"fieldString","type":"string"},{"name":"fieldNumber","type":"number"},{"name":"player","type":"ref","referencedType":0},{"name":"arrayOfPlayers","type":"array","referencedType":0},{"name":"mapOfPlayers","type":"map","referencedType":0}]}],"rootType":1}'
        );
    });

    it("should initialize ref types with empty structures", () => {
        const state = new State();
        const stateReflected = Reflection.decode(Reflection.encode(state)) as State;

        assert.strictEqual(stateReflected.arrayOfPlayers.length, 0);
        assert.strictEqual(Array.from(stateReflected.mapOfPlayers.keys()).length, 0);
        assert.strictEqual(JSON.stringify(stateReflected.player), "{}");
    });

    it("should decode schema and be able to use it", () => {
        const state = new State();
        const stateReflected = Reflection.decode(Reflection.encode(state)) as State;

        assert.deepEqual(state['_definition'].indexes, stateReflected['_definition'].indexes);

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
        assert.strictEqual(stateReflected.mapOfPlayers['one'].name, "player one");
        assert.strictEqual(stateReflected.mapOfPlayers['one'].x, 2);
        assert.strictEqual(stateReflected.mapOfPlayers['one'].y, 2);
        assert.strictEqual(stateReflected.mapOfPlayers['two'].name, "player two");
        assert.strictEqual(stateReflected.mapOfPlayers['two'].x, 3);
        assert.strictEqual(stateReflected.mapOfPlayers['two'].y, 3);

        assert.strictEqual(stateReflected.arrayOfPlayers.length, 1);
        assert.strictEqual(stateReflected.arrayOfPlayers[0].name, "in array");
        assert.strictEqual(stateReflected.arrayOfPlayers[0].x, 4);
        assert.strictEqual(stateReflected.arrayOfPlayers[0].y, 4);
    });

    it("should allow extending another Schema type", () => {
        const type = Context.create();

        class Point extends Schema {
            @type("number") x: number;
            @type("number") y: number;

            constructor (x: number, y: number) {
                super();
                this.x = x;
                this.y = y;
            }
        }

        class Player extends Point {
            @type("string") name: string;

            constructor (x: number, y: number, name: string) {
                super(x, y);
                this.name = name;
            }
        }

        class MyState extends Schema {
            @type([ Point ])
            points = new ArraySchema<Point>();

            @type([ Player ])
            players = new ArraySchema<Player>();
        }

        const state = new MyState();
        const encodedReflection = Reflection.encode(state);

        const decodedState = Reflection.decode(encodedReflection) as MyState;
        assert.deepEqual(Object.keys(decodedState['_definition'].schema.points['array']._definition.schema), ['x', 'y'])
        assert.deepEqual(Object.keys(decodedState['_definition'].schema.players['array']._definition.schema), ['x', 'y', 'name'])
    });

    it("should reflect map of primitive type", () => {
        const type = Context.create();

        class MyState extends Schema {
            @type({map: "string"})
            mapOfStrings: MapSchema<string> = new MapSchema();
        }

        const state = new MyState();
        const decodedState = Reflection.decode<MyState>(Reflection.encode(state));

        state.mapOfStrings['one'] = "one";
        state.mapOfStrings['two'] = "two";
        decodedState.decode(state.encode());

        assert.strictEqual(JSON.stringify(decodedState), '{"mapOfStrings":{"one":"one","two":"two"}}');
    });

    it("should reflect array of primitive type", () => {
        const type = Context.create();

        class MyState extends Schema {
            @type([ "string" ])
            arrayOfStrings: ArraySchema<string> = new ArraySchema();
        }

        const state = new MyState();
        const decodedState = Reflection.decode(Reflection.encode(state)) as MyState;

        state.arrayOfStrings.push("one")
        state.arrayOfStrings.push("two");
        decodedState.decode(state.encode());

        assert.strictEqual(JSON.stringify(decodedState), '{"arrayOfStrings":["one","two"]}');
    });

    it("should reflect and be able to use multiple structures of primitive tyes", () => {
        const type = Context.create();

        class MyState extends Schema {
            @type("string")
            currentTurn: string;

            @type({ map: "number" })
            players: MapSchema<number>;

            @type(["number"])
            board: ArraySchema<number>;

            @type("string")
            winner: string;

            @type("boolean")
            draw: boolean;
        }

        const state = new MyState();
        state.currentTurn = "one";
        state.players = new MapSchema();
        state.board = new ArraySchema(0, 0, 0, 0, 0, 0, 0, 0, 0);
        state.players['one'] = 1;

        const decodedState = Reflection.decode(Reflection.encode(state)) as MyState;
        decodedState.decode(state.encodeAll());

        const decodedState2 = Reflection.decode(Reflection.encode(state)) as MyState;
        decodedState2.decode(state.encodeAll());

        assert.strictEqual(JSON.stringify(decodedState),  '{"currentTurn":"one","players":{"one":1},"board":[0,0,0,0,0,0,0,0,0]}');
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

        const decodedState = Reflection.decode(Reflection.encode(state));
        assert.doesNotThrow(() => decodedState.decode(state.encode()));
    });
});