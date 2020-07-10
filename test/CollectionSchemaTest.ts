import * as assert from "assert";

import { Schema, type, filter, filterChildren, CollectionSchema } from "../src";
import { Client } from "../src/annotations";

describe("CollectionSchema Tests", () => {

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

        assert.equal(3, decoded.strings.size);
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

        state.players.delete(player);
        decoded.decode(state.encode());

        assert.equal(4, decoded.players.size);
        assert.equal(decoded.players.at(0), decoded.players.at(1));
        assert.equal(decoded.players.at(1), decoded.players.at(2));
        assert.equal(decoded.players.at(2), decoded.players.at(3));
        assert.equal(undefined, decoded.players.at(4));
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
        assert.equal(1, decoded.players.size);

        const removed = state.players.delete(player);
        assert.equal(true, removed, "should return true if item has been removed successfully.");
        assert.equal(false, state.players.delete(player), "should return false if item does not exist.");
        assert.equal(false, state.players.delete({} as any), "should return false if item does not exist.");

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

    it("@filterChildren() should filter out schema instances", () => {
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

    it("@filterChildren() should filter out primitive values", () => {
        class State extends Schema {
            @filterChildren(function (client: Client, key: number, value: number) {
                if (client.sessionId === "one") {
                    return value % 2 === 0;
                } else {
                    return value % 2 === 1;
                }
            })
            @type({ collection: "number" })
            numbers = new CollectionSchema<number>();
        }

        const state = new State();
        state.numbers.add(0);
        state.numbers.add(1);
        state.numbers.add(2);
        state.numbers.add(3);
        state.numbers.add(4);
        state.numbers.add(5);
        state.numbers.add(6);
        state.numbers.add(7);
        state.numbers.add(8);
        state.numbers.add(9);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        let encoded = state.encode(undefined, undefined, undefined, true);

        const filtered1 = state.applyFilters(encoded, client1);
        const filtered2 = state.applyFilters(encoded, client2);

        const decoded1 = new State();
        decoded1.decode(filtered1)

        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.equal(5, decoded1.numbers.size);
        assert.deepEqual([0, 2, 4, 6, 8], decoded1.numbers.toArray());

        assert.equal(5, decoded2.numbers.size);
        assert.deepEqual([1, 3, 5, 7, 9], decoded2.numbers.toArray());
    });

    it("CollectionSchema.toJSON", () => {
        const collection = new CollectionSchema<number>();
        collection.add(1);
        collection.add(2);
        collection.add(3);

        assert.deepEqual([1, 2, 3], collection.toJSON());
    })

});
