import * as assert from "assert";

import { ChangeTree } from "../src/encoder/ChangeTree";
import { Schema, type, view, MapSchema, ArraySchema, $changes, OPERATION } from "../src";
import { assertDeepStrictEqualEncodeAll, assertRefIdCounts, getDecoder, getEncoder } from "./Schema";
import { nanoid } from "nanoid";

describe("ChangeTree", () => {
    describe("changeset internals", () => {
        class State extends Schema {
            @type("string") str: string;
            @type("number") num: number;
            @type({ map: "number" }) map = new MapSchema<number>();
            @type([ "number" ]) array = new ArraySchema<number>();
        }

        it("change() should add operation to changeset", () => {
            const state = new State();

            const changeTree = new ChangeTree(state);
            changeTree.change(0, OPERATION.ADD);

            assert.deepStrictEqual(changeTree.indexedOperations, { '0': OPERATION.ADD });
            assert.deepStrictEqual(changeTree.changes.indexes, { '0': 0 });
            assert.deepStrictEqual(changeTree.changes.operations, [0]);
            assert.deepStrictEqual(changeTree.allChanges.indexes, { '0': 0 });
            assert.deepStrictEqual(changeTree.allChanges.operations, [0]);

            changeTree.change(1, OPERATION.ADD);
            assert.deepStrictEqual(changeTree.indexedOperations, { '0': OPERATION.ADD, '1': OPERATION.ADD });
            assert.deepStrictEqual(changeTree.changes.indexes, { '0': 0, '1': 1 });
            assert.deepStrictEqual(changeTree.changes.operations, [0, 1]);
            assert.deepStrictEqual(changeTree.allChanges.indexes, { '0': 0, '1': 1  });
            assert.deepStrictEqual(changeTree.allChanges.operations, [0, 1]);

            changeTree.delete(0, OPERATION.DELETE);
            assert.deepStrictEqual(changeTree.indexedOperations, { '0': OPERATION.DELETE, '1': OPERATION.ADD });
            assert.deepStrictEqual(changeTree.changes.indexes, { '0': 0, '1': 1 });
            assert.deepStrictEqual(changeTree.changes.operations, [0, 1]);
            assert.deepStrictEqual(changeTree.allChanges.indexes, { '1': 1  });
            assert.deepStrictEqual(changeTree.allChanges.operations, [undefined, 1]);
        });
    });

    it("instances should share parent/root references", () => {
        class Skill extends Schema {
            @type("number") damage: number;
        }

        class Item extends Schema {
            @type("number") damage: number;
            @type({ map: Skill }) skills = new Map<string, Skill>();
        }

        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            @type(Item) item: Item;
        }

        class State extends Schema {
            @type("string") str: string;
            @type("number") num: number;
            @type({ map: Player }) players: Map<string, Player>;
            @type(Player) player: Player;
        };

        const state = new State();
        const player = new Player();
        player.item = new Item();
        state.player = player;

        const players = new Map<string, Player>();
        players.set("one", new Player());
        players.get("one").item = new Item();

        state.players = players;

        // Testing for "root".
        const $root = state[$changes].root;
        assert.ok(player[$changes].root === $root, "State and Player should have same 'root'.");
        assert.ok(player.item[$changes].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one")[$changes].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one").item[$changes].root === $root, "Player and Item should have same 'root'.");

        // Testing for "parent".
        assert.ok(state[$changes].parent === undefined, "State parent should be 'undefined'");
        assert.ok(state.player[$changes].parent === state, "Player parent should be State");
        assert.ok(state.player.item[$changes].parent === player, "Item parent should be Player");
        assert.ok(state.players.get("one")[$changes].parent[$changes].refId === state.players[$changes].refId as any, "state.players['one'] parent should be state.players");
    });

    it("change", () => {
        class State extends Schema {
            @type("string")
            stringValue: string;

            @type("number")
            intValue: number;
        }

        const encoded = new State();
        encoded.stringValue = "hello world";
        encoded.intValue = 10;

        const decoded = new State();
        decoded.decode(encoded.encode());

        assert.strictEqual(decoded.stringValue, "hello world");
        assert.strictEqual(decoded.intValue, 10);
    });

    it("remove", () => {
        class State extends Schema {
            @type("string")
            stringValue: string;

            @type("number")
            intValue: number;
        }

        const encoded = new State();
        encoded.stringValue = "hello world";
        encoded.intValue = 10;

        const decoded = new State();
        decoded.decode(encoded.encode());

        encoded.intValue = undefined;
        decoded.decode(encoded.encode());

        assert.strictEqual(decoded.stringValue, "hello world");
        assert.strictEqual(decoded.intValue, undefined);
    });

    it("should not identify changes on untyped properties", () => {
        class Game extends Schema {
            @type('string') state: string = "starting";
            privProperty: number = 50;
        }

        class State extends Schema {
            @type(Game) game: Game;
        }

        const state = new State();
        state.game = new Game(0, 1);

        const changes: ChangeTree = state.game[$changes];
        assert.deepStrictEqual(changes.changes.operations, [0]);
        assert.deepStrictEqual(changes.allChanges.operations, [0]);
    });

    it("should not instantiate 'filteredChanges'", () => {
        class MyState extends Schema {
            @type("string") str: string;
        }

        const state = new MyState();
        assert.strictEqual(undefined, state[$changes].filteredChanges);
        assert.strictEqual(undefined, state[$changes].allFilteredChanges);
    })

    it("should instantiate 'filteredChanges'", () => {
        class MyState extends Schema {
            @view() @type("string") str: string;
        }

        const state = new MyState();
        assert.ok(state[$changes].filteredChanges !== undefined);
        assert.ok(state[$changes].allFilteredChanges !== undefined);
    })

    it("detached instance and filtered changes", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }

        class State extends Schema {
            @type("string") prop1 = "Hello world";
            @view() @type([Item]) items = new ArraySchema<Item>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        for (let i = 0; i < 5; i++) {
            state.items.push(new Item().assign({ amount: i }));
        }

        assert.strictEqual(-1, Array.from(encoder.root.allFilteredChanges.values()).findIndex((value) => value === undefined))
    });

    describe("replacing instance should detach previous reference", () => {
        it("using Schema: replace should be DELETE_AND_ADD operation", () => {
            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
            }
            class State extends Schema {
                @type(Entity) entity: Entity;
            }

            const state = new State();
            const decodedState = new State();

            const encoder = getEncoder(state);
            const decoder = getDecoder(decodedState);

            const entity1 = new Entity();
            state.entity = entity1;
            decodedState.decode(state.encode());

            const entity2 = new Entity();
            state.entity = entity2;
            decodedState.decode(state.encode());

            assert.strictEqual(1, encoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(0, encoder.root.refCount[entity1[$changes].refId]);

            assert.strictEqual(1, decoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(undefined, decoder.root.refCount[entity1[$changes].refId]);

            assertDeepStrictEqualEncodeAll(state);
        })

        it("using MapSchema: replace should be DELETE_AND_ADD operation", () => {
            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
            }
            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const decodedState = new State();
            const decoder = getDecoder(decodedState);

            const entity1 = new Entity();
            state.entities.set("one", entity1);
            decodedState.decode(state.encode());

            const entity2 = new Entity();
            state.entities.set("one", entity2);
            decodedState.decode(state.encode());

            assert.strictEqual(1, encoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(0, encoder.root.refCount[entity1[$changes].refId]);

            assert.strictEqual(1, decoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(undefined, decoder.root.refCount[entity1[$changes].refId]);

            assertDeepStrictEqualEncodeAll(state);

        });

        it("using ArraySchema: replace should be DELETE_AND_ADD operation", () => {
            class Entity extends Schema {
                @type("string") id: string = nanoid(9);
            }
            class State extends Schema {
                @type([Entity]) entities = new ArraySchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const decodedState = new State();
            const decoder = getDecoder(decodedState);

            const entity1 = new Entity();
            state.entities.push(entity1);
            decodedState.decode(state.encode());

            const entity2 = new Entity();
            state.entities[0] = entity2;
            decodedState.decode(state.encode());
            assertRefIdCounts(state, decodedState);

            assert.strictEqual(1, encoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(0, encoder.root.refCount[entity1[$changes].refId]);

            assert.strictEqual(1, decoder.root.refCount[entity2[$changes].refId]);
            assert.strictEqual(undefined, decoder.root.refCount[entity1[$changes].refId]);

            assertDeepStrictEqualEncodeAll(state);
        });

    });

});
