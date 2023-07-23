import * as assert from "assert";

import { ChangeTree } from "../src/changes/ChangeTree";
import { Schema, type, MapSchema, ArraySchema } from "../src";

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
        const $root = state['$changes'].root;
        assert.ok(player['$changes'].root === $root, "State and Player should have same 'root'.");
        assert.ok(player.item['$changes'].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one")['$changes'].root === $root, "Player and Item should have same 'root'.");
        assert.ok(state.players.get("one").item['$changes'].root === $root, "Player and Item should have same 'root'.");

        // Testing for "parent".
        assert.ok(state['$changes'].parent === undefined, "State parent should be 'undefined'");
        assert.ok(state.player['$changes'].parent === state, "Player parent should be State");
        assert.ok(state.player.item['$changes'].parent === player, "Item parent should be Player");
        assert.ok(state.players.get("one")['$changes'].parent['$changes'].refId === state.players['$changes'].refId as any, "state.players['one'] parent should be state.players");
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

    xit("should not identify changes on untyped properties", () => {
        class Game extends Schema {
            @type('string')
            state: string = "starting";
            privProperty: number = 50;
        }

        class State extends Schema {
            @type(Game)
            game: Game;
        }

        const state = new State();
        state.game = new Game(0, 1);

        const changes: ChangeTree = (state.game as any).$changes;
        assert.deepEqual(Array.from(changes.changes), [0])
        assert.deepEqual(Array.from(changes.allChanges), [0])
    });

});
