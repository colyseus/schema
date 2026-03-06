import * as assert from "assert";
import { State, Player, DeepState, DeepMap, DeepChild, Position, DeepEntity } from "./Schema";
import { Schema, ArraySchema, MapSchema, type } from "../src";

describe("TypeScript Types", () => {
    it("strict null/undefined checks", () => {
        class Player extends Schema {
            @type("number") orderPriority: number;
        }
        class MyState extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new MyState();
        state.players.set("one", new Player().assign({
            orderPriority: null,
        }));
        state.encodeAll();
        assert.ok(true);
    });

    describe("complex declaration scenarios", () => {
        it("implements / extends interfaces without conflicts", () => {
            // Defines a generic schema
            interface SchemaInterface extends Schema {
                players: Map<string, string>;
                items: string[];
            }

            // Implements the above interface
            // MapSchema is compatible with Map
            class SchemaInterfaceImpl extends Schema implements SchemaInterface {
                players: MapSchema<string>;
                items: ArraySchema<string>;
            }

            // Uses the schema interface
            abstract class AbstractRoom<T extends SchemaInterface> { }

            // Uses the schema implementation
            class AbstractRoomImpl extends AbstractRoom<SchemaInterfaceImpl> { }
        });

        it("custom generic with inheritance", () => {
            class Actions extends Schema {
                @type("string") actionTypes: string;
            }

            class NodeBase extends Schema {
                @type("string") id: string; // < if you comment this line the error a goes away...
            }

            class TreeBase<N extends NodeBase> extends Schema {
                @type("string") id: string;

                @type([NodeBase]) nodes = new ArraySchema<N>();
            }

            class SpecialNode<E extends Actions> extends NodeBase {
                @type("string") type: string;

                @type(Actions) actions: E; // < if you comment this line the error also goes away...
            }

            // Here I get the typescript error "Type 'SpecialNode<E>' does not satisfy the constraint 'NodeBase'"
            class SpecialTree<E extends Actions> extends TreeBase<SpecialNode<E>> {
                @type("string") user: string;
            }
        });
    });

});