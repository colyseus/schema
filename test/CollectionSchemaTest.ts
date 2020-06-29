import * as sinon from "sinon";
import * as assert from "assert";
import * as util from "util";

import { Schema, type, filter, CollectionSchema, dumpChanges } from "../src";

describe("CollectionSchema Tests", () => {

    it("add()", () => {
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

        assert.equal(1, decoded.players.size);
    })

    it("remove()", () => {
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
        assert.equal(1, decoded.players.size);

        const removed = state.players.remove(player);
        assert.equal(true, removed, "should return true if item has been removed successfully.");
        assert.equal(false, state.players.remove(player), "should return false if item does not exist.");
        assert.equal(false, state.players.remove({} as any), "should return false if item does not exist.");

        decoded.decode(state.encode());

        assert.equal(0, decoded.players.size);
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
        assert.equal(5, decoded.players.size);

        state.players.clear();
        decoded.decode(state.encode());

        assert.equal(0, decoded.players.size);
    });

});
