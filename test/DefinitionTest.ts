import * as assert from "assert";

import { Schema, type, MapSchema, filter, hasFilter, ArraySchema } from "../src";
import { defineTypes } from "../src/annotations";

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
        obj.players['one'] = new Player();

        assert.deepEqual(Object.keys(obj), ['str', 'players', 'notSynched']);
        assert.deepEqual(Array.from(obj.players.keys()), ['one']);
        assert.deepEqual(Object.keys(obj.players['one']), ['x', 'y', 'somethingPrivate']);
    });

    it("should allow a Schema instance with no fields", () => {
        class IDontExist extends Schema {}

        const obj = new IDontExist();
        assert.deepEqual(Object.keys(obj), []);
    });

    describe("defineTypes", () => {
        it("should be equivalent", () => {
            class MyExistingStructure extends Schema {}
            defineTypes(MyExistingStructure, { name: "string" });

            const state = new MyExistingStructure();
            (state as any).name = "hello world!";

            const decodedState = new MyExistingStructure();
            decodedState.decode(state.encode());
            assert.equal((decodedState as any).name, "hello world!");
        });
    });

    describe("hasFilter()", () => {
        it("should return false", () => {
            class State extends Schema {
                @type("string") str: string;
            }

            assert.ok(!hasFilter(State));
        });

        it("should return true", () => {
            class State extends Schema {
                @filter(function (client, value, root) {
                    return true;
                })
                @type("string") str: string;
            }

            assert.ok(hasFilter(State));
        });

        it("should be able to navigate on recursive structures", () => {
            class Container extends Schema {
                @type("string") name: string;

                @type([Container]) arrayOfContainers: ArraySchema<Container>;
                @type({ map: Container }) mapOfContainers: MapSchema<Container>;
            }
            class State extends Schema {
                @type(Container) root: Container;
            }

            const fun = () => hasFilter(State);

            assert.doesNotThrow(fun);
            assert.equal(false, fun());
        });

        it("should be able to navigate on more complex recursive structures", () => {
            class ContainerA extends Schema {
                @type("string") contAName: string;
            }
            class ContainerB extends Schema {
                @type("string") contBName: string;
            }
            class State extends Schema {
            }

            const allContainers = [State, ContainerA, ContainerB];
            allContainers.forEach((cont) => {
                defineTypes(cont, {
                    containersA: [ContainerA],
                    containersB: [ContainerB],
                });
            });

            const fun = () => hasFilter(State);

            assert.doesNotThrow(fun);
            assert.equal(false, fun());
        });

        it("should find filter on more complex recursive structures - array", () => {
            class ContainerA extends Schema {
                @type("string") contAName: string;
            }
            class ContainerB extends Schema {
                @filter(function (client, value, root) { return true; })
                @type("string")
                contBName: string;
            }
            class State extends Schema {
            }

            const allContainers = [State, ContainerA, ContainerB];
            allContainers.forEach((cont) => {
                defineTypes(cont, {
                    containersA: [ContainerA],
                    containersB: [ContainerB],
                });
            });

            assert.ok(hasFilter(State));
        });

        it("should find filter on more complex recursive structures - map", () => {
            class ContainerA extends Schema {
                @type("string") contAName: string;
            }
            class ContainerB extends Schema {
                @filter(function (client, value, root) { return true; })
                @type("string")
                contBName: string;
            }
            class State extends Schema {
            }

            const allContainers = [State, ContainerA, ContainerB];
            allContainers.forEach((cont) => {
                defineTypes(cont, {
                    containersA: { map: ContainerA },
                    containersB: { map: ContainerB },
                });
            });

            assert.ok(hasFilter(State));
        });

        it("should be able to navigate on maps and arrays of primitive types", () => {
            class State extends Schema {
                @type(["string"]) stringArr: MapSchema<string>;
                @type(["number"]) numberArr: MapSchema<number>;
                @type(["boolean"]) booleanArr: MapSchema<boolean>;
                @type({ map: "string" }) stringMap: MapSchema<string>;
                @type({ map: "number" }) numberMap: MapSchema<number>;
                @type({ map: "boolean" }) booleanMap: MapSchema<boolean>;
            }

            const fun = () => hasFilter(State);

            assert.doesNotThrow(fun);
            assert.equal(false, fun());
        });

    });
});