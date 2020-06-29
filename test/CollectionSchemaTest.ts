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

        state.players.remove(player)
        decoded.decode(state.encode());

        assert.equal(0, decoded.players.size);
    });


});
