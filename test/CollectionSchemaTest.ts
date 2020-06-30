import * as sinon from "sinon";
import * as assert from "assert";
import * as util from "util";

import { Schema, type, filter, filterChildren, CollectionSchema, dumpChanges } from "../src";
import { Client } from "../src/annotations";

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

        assert.equal(5, decoded.players.size);
        assert.equal(decoded.players.at(0), decoded.players.at(1));
        assert.equal(decoded.players.at(1), decoded.players.at(2));
        assert.equal(decoded.players.at(2), decoded.players.at(3));
        assert.equal(decoded.players.at(3), decoded.players.at(4));
        assert.equal(undefined, decoded.players.at(5));

        state.players.remove(player);
        decoded.decode(state.encode());

        assert.equal(4, decoded.players.size);
        assert.equal(decoded.players.at(0), decoded.players.at(1));
        assert.equal(decoded.players.at(1), decoded.players.at(2));
        assert.equal(decoded.players.at(2), decoded.players.at(3));
        assert.equal(undefined, decoded.players.at(4));
    });

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

    it("@filter() should filter out Collection field entirely.", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @filter(function(client: Client, value, root) {
                return client.sessionId === "one";
            })
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 1 }));
        state.players.add(new Player().assign({ level: 2 }));

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        let encoded = state.encode(undefined, undefined, undefined, true);

        const filtered1 = state.applyFilters(encoded, client1);
        const filtered2 = state.applyFilters(encoded, client2);

        const decoded1 = new State();
        decoded1.decode(filtered1)

        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.equal(2, decoded1.players.size);
        assert.equal(0, decoded2.players.size);
    });

    it("@filterChildren() should filter out specific entries", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @filterChildren(function (client: Client, key: number, value: Player) {
                console.log("@filterChildren()", { client, key, value });
                if (client.sessionId === "one") {
                    console.log("RETURN", key % 2 === 0);
                    return key % 2 === 0;
                } else {
                    console.log("RETURN", key % 2 === 1);
                    return key % 2 === 1;
                }
            })
            @type({ collection: Player })
            players = new CollectionSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 1 }));
        state.players.add(new Player().assign({ level: 2 }));

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        let encoded = state.encode(undefined, undefined, undefined, true);

        const filtered1 = state.applyFilters(encoded, client1);
        const filtered2 = state.applyFilters(encoded, client2);

        const decoded1 = new State();
        decoded1.decode(filtered1)

        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.equal(1, decoded1.players.size);
        assert.equal(1, decoded1.players.at(0).level);

        assert.equal(1, decoded2.players.size);
        assert.equal(2, decoded2.players.at(0).level);
    });

});
