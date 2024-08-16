import * as assert from "assert";

import { Schema, type, CollectionSchema } from "../src";

describe("CollectionSchema", () => {

    it("add() primitive values", () => {
        class State extends Schema {
            @type({ collection: "string" })
            strings = new CollectionSchema<string>();
        }

        const state = new State();
        state.strings.add("one");
        state.strings.add("two");
        state.strings.add("three");

        const decoded = new State();
        decoded.decode(state.encode());

        assert.strictEqual(3, decoded.strings.size);
    })

    it("add() schema instances", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 10 }));

        const decoded = new State();
        decoded.decode(state.encode());

        assert.strictEqual(1, decoded.players.size);
    })

    it("add() - should support adding multiple references", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        const player = new Player().assign({ level: 10 });
        state.players.add(player);
        state.players.add(player);
        state.players.add(player);
        state.players.add(player);
        state.players.add(player);

        const decoded = new State();
        decoded.decode(state.encode());

        assert.strictEqual(5, decoded.players.size);
        assert.strictEqual(decoded.players.at(0), decoded.players.at(1));
        assert.strictEqual(decoded.players.at(1), decoded.players.at(2));
        assert.strictEqual(decoded.players.at(2), decoded.players.at(3));
        assert.strictEqual(decoded.players.at(3), decoded.players.at(4));
        assert.strictEqual(undefined, decoded.players.at(5));

        state.players.delete(player);
        decoded.decode(state.encode());

        assert.strictEqual(4, decoded.players.size);
        assert.strictEqual(decoded.players.at(0), decoded.players.at(1));
        assert.strictEqual(decoded.players.at(1), decoded.players.at(2));
        assert.strictEqual(decoded.players.at(2), decoded.players.at(3));
        assert.strictEqual(undefined, decoded.players.at(4));
    });

    it("delete()", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        const player = new Player().assign({ level: 10 });
        state.players.add(player);

        const decoded = new State();
        decoded.decode(state.encode());
        assert.strictEqual(1, decoded.players.size);

        const removed = state.players.delete(player);
        assert.strictEqual(true, removed, "should return true if item has been removed successfully.");
        assert.strictEqual(false, state.players.delete(player), "should return false if item does not exist.");
        assert.strictEqual(false, state.players.delete({} as any), "should return false if item does not exist.");

        decoded.decode(state.encode());

        assert.strictEqual(0, decoded.players.size);
    });

    it("clear()", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 10 }));
        state.players.add(new Player().assign({ level: 20 }));
        state.players.add(new Player().assign({ level: 30 }));
        state.players.add(new Player().assign({ level: 40 }));
        state.players.add(new Player().assign({ level: 50 }));

        const decoded = new State();
        decoded.decode(state.encode());
        assert.strictEqual(5, decoded.players.size);

        state.players.clear();
        decoded.decode(state.encode());

        assert.strictEqual(0, decoded.players.size);
    });

    it("CollectionSchema.toJSON", () => {
        const collection = new CollectionSchema<number>();
        collection.add(1);
        collection.add(2);
        collection.add(3);

        assert.deepEqual([1, 2, 3], collection.toJSON());
    })

});
