import * as assert from "assert";

import { ChangeTree } from "../src/ChangeTree";
import { Schema, type, MapSchema, ArraySchema } from "../src";

describe("Next Iteration", () => {

    xit("add and modify an array item", () => {
        class State extends Schema {
            @type(["string"])
            arr: string[]
        }

        const encoded = new State({ arr: [] });
        encoded.arr.push("one");
        encoded.arr.push("two");
        encoded.arr.push("three");

        const decoded = new State();
        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.arr, ['one', 'two', 'three']);

        encoded.arr[1] = "twotwo";
        decoded.decode(encoded.encode());

        assert.deepEqual(decoded.arr, ['one', 'twotwo', 'three']);
    });

    it("add and modify a map item", () => {
        class State extends Schema {
            @type({ map: "number" })
            map = new Map<string, number>();
        }

        const encoded = new State();
        encoded.map.set("one", 1);
        encoded.map.set("two", 2);
        encoded.map.set("three", 3);

        const decoded = new State();
        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.map.get("one"), 1);
        assert.deepEqual(decoded.map.get("two"), 2);
        assert.deepEqual(decoded.map.get("three"), 3);

        encoded.map.set("two", 22);

        decoded.decode(encoded.encode());
        assert.deepEqual(decoded.map.get("two"), 22);
    });

    xit("simple relationship", () => {
        const root = new ChangeTree();

        const child = new ChangeTree({}, "child");
        child.parent = root;

        child.change("x");

        assert.equal(root.changed, true);
        assert.equal(child.changed, true);

        assert.deepEqual(Array.from(root.changes), ['child'])
        assert.deepEqual(Array.from(child.changes), ['x'])
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
