import * as assert from "assert";

import { ChangeTree } from "../src/ChangeTree";
import { Schema, type, MapSchema, ArraySchema } from "../src";

describe("ChangeTree", () => {

    it("simple relationship", () => {
        const root = new ChangeTree();

        const child = new ChangeTree({}, "child");
        child.parent = root;

        child.change("x");

        assert.equal(root.changed, true);
        assert.equal(child.changed, true);

        assert.deepEqual(Array.from(root.changes), ['child'])
        assert.deepEqual(Array.from(child.changes), ['x'])
    });

    it("should not identify changes on untyped properties", () => {
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
