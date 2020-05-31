import * as assert from "assert";

import { ChangeTree } from "../src/changes/ChangeTree";
import { Schema, type, MapSchema, ArraySchema } from "../src";

describe("ChangeTree", () => {
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

        assert.equal(decoded.stringValue, "hello world");
        assert.equal(decoded.intValue, 10);
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

        assert.equal(decoded.stringValue, "hello world");
        assert.equal(decoded.intValue, undefined);
    });

    it("add and modify an array item", () => {
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
