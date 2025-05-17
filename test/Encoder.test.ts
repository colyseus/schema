import * as assert from "assert";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes, entity } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder, getDecoder } from "./Schema";

describe("Encoder", () => {
    const bufferSize = Encoder.BUFFER_SIZE;

    before(() => Encoder.BUFFER_SIZE = 16);
    after(() => Encoder.BUFFER_SIZE = bufferSize);

    it("should resize buffer", () => {
        const state = new State();

        state.mapOfPlayers = new MapSchema<Player>();
        for (let i=0;i<5000;i++) {
            state.mapOfPlayers.set("player" + i, new Player().assign({
                name: "Player " + i,
                x: 50 * i,
                y: 50 * i,
            }));
        }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());
    });

    Encoder.BUFFER_SIZE = 16 * 1024;

    describe("dynamic schema operations", () => {
        /**
         * Helper that encodes the state, decodes into a fresh reflected instance,
         * and asserts deep equality + refId/refCount match between encoder & decoder.
         */
        function encodeDecodeAndAssert<S extends Schema>(state: S) {
            const encoder = getEncoder(state);
            const bytes = state.encode();
            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            decodedState.decode(bytes);
            assertDeepStrictEqualEncodeAll(state);
            // Ensure refId counts match between encoder & decoder
            for (const refId in encoder.root.refCount) {
                assert.strictEqual(
                    encoder.root.refCount[refId],
                    decoder.root.refCounts[refId] ?? 0,
                    `refCount mismatch for refId=${refId}`
                );
            }
        }

        it("should handle moving shared instances between array <-> map <-> field", () => {
            class Item extends Schema {
                @type("string") id: string = Math.random().toString(36).slice(2);
            }
            class Container extends Schema {
                @type([Item]) list = new ArraySchema<Item>();
                @type({ map: Item }) bag = new MapSchema<Item>();
                @type(Item) equipped: Item;
            }

            const state = new Container();

            // create two shared items
            const sword = new Item();
            const shield = new Item();

            // initial placement
            state.list.push(sword, shield);
            encodeDecodeAndAssert(state);

            // move "sword" from array to map key "sword"
            state.bag.set("sword", sword);
            state.list.splice(state.list.indexOf(sword), 1);
            encodeDecodeAndAssert(state);

            // equip the sword (shared reference now field & map)
            state.equipped = sword;
            encodeDecodeAndAssert(state);

            // unequip and move back to array
            state.equipped = undefined;
            state.list.push(sword);
            state.bag.delete("sword");
            encodeDecodeAndAssert(state);
        });

        it("should replace instances multiple times in nested structures", () => {
            class Child extends Schema {
                @type("number") value: number = 0;
            }
            class Parent extends Schema {
                @type(Child) a: Child;
                @type(Child) b: Child;
            }

            const state = new Parent();
            const c1 = new Child().assign({ value: 1 });
            const c2 = new Child().assign({ value: 2 });
            const c3 = new Child().assign({ value: 3 });

            state.a = c1;
            state.b = c1; // shared initially
            encodeDecodeAndAssert(state);

            // replace a with new instance
            state.a = c2;
            encodeDecodeAndAssert(state);

            // replace b with another new instance
            state.b = c3;
            encodeDecodeAndAssert(state);

            // finally point both to same again
            state.a = state.b;
            encodeDecodeAndAssert(state);
        });

        it("should survive clear & repopulate on ArraySchema with shared children", () => {
            class Node extends Schema {
                @type("string") id: string = Math.random().toString(36).substring(2);
            }
            class Graph extends Schema {
                @type([Node]) nodes = new ArraySchema<Node>();
                @type({ map: Node }) lookup = new MapSchema<Node>();
            }

            const state = new Graph();
            // add 5 nodes, share references between array & map
            for (let i = 0; i < 5; i++) {
                const n = new Node();
                state.nodes.push(n);
                state.lookup.set(n.id, n);
            }
            encodeDecodeAndAssert(state);

            // clear array – map still holds them
            state.nodes.clear();
            encodeDecodeAndAssert(state);

            // repopulate array using map values (shared again)
            state.lookup.forEach(node => state.nodes.push(node));
            encodeDecodeAndAssert(state);

            // now clear map completely
            state.lookup.clear();
            encodeDecodeAndAssert(state);
        });
    });
});
