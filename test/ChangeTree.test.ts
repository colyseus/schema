import * as assert from "assert";

import { ChangeTree } from "../src/encoder/ChangeTree";
import { Schema, type, view, MapSchema, ArraySchema, $changes } from "../src";
import { getEncoder } from "./Schema";

describe("ChangeTree", () => {
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
        assert.deepStrictEqual(Object.keys(changes.changes).map(k => Number(k)), [0]);
        assert.deepStrictEqual(Object.keys(changes.allChanges).map(k => Number(k)), [0]);
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

});
