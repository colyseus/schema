import * as assert from "assert";

import { Schema, type, MapSchema, ArraySchema, Reflection } from "../src";
import { defineTypes } from "../src/annotations";
import { createInstanceFromReflection, getDecoder, getEncoder } from "./Schema";

describe("Definition Tests", () => {

    it("private Schema fields should be part of enumerable keys", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            somethingPrivate: number = 10;
        }
        class MySchema extends Schema {
            @type("string")
            str: string;

            @type({map: Player})
            players = new MapSchema<Player>();

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

            assert.strictEqual(0, Props[Symbol.metadata]["$_numFields"]);
            assert.strictEqual(2, ExtendedProps[Symbol.metadata]["$_numFields"]);

            const state = new State();
            const originalContext = getDecoder(state).context;

            const reflectedState = createInstanceFromReflection(state);
            const reflectedContext = getDecoder(reflectedState).context;

            assert.strictEqual(
                // state.extendedProps -> props.str
                originalContext.types[0][Symbol.metadata][1].type[Symbol.metadata][0].index,
                reflectedContext.types[0][Symbol.metadata][1].type[Symbol.metadata][0].index
            );

            assert.strictEqual(
                // state.extendedProps -> props.id
                originalContext.types[0][Symbol.metadata][1].type[Symbol.metadata][1].index,
                reflectedContext.types[0][Symbol.metadata][1].type[Symbol.metadata][1].index
            );

            assert.strictEqual(
                // state.extendedProps -> props.value
                originalContext.types[0][Symbol.metadata][1].type[Symbol.metadata][2].index,
                reflectedContext.types[0][Symbol.metadata][1].type[Symbol.metadata][2].index
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

});