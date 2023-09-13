import * as assert from "assert";

import { Schema, type, filter, filterChildren, SetSchema } from "../src";
import { ClientWithSessionId } from "../src/annotations";

describe("SetSchema Tests", () => {

    it("add() primitive values", () => {
        class State extends Schema {
            @type({ set: "string" })
            strings = new SetSchema<string>();
        }

        const state = new State();
        state.strings.add("one");
        state.strings.add("one");
        state.strings.add("two");
        state.strings.add("two");
        state.strings.add("three");
        state.strings.add("three");

        const decoded = new State();
        decoded.decode(state.encodeAll());
        decoded.decode(state.encode());

        assert.strictEqual(3, decoded.strings.size);
    })

    it("add() schema instances", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ set: Player })
            players = new SetSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 10 }));

        const decoded = new State();
        decoded.decode(state.encodeAll());
        decoded.decode(state.encode());

        assert.strictEqual(1, decoded.players.size);
    })

    it("add() - should support adding multiple references", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ set: Player })
            players = new SetSchema<Player>();
        }

        const state = new State();

        const player = new Player().assign({ level: 10 });
        state.players.add(player);
        state.players.add(player);
        assert.strictEqual(1, state.players.size);

        const player2 = new Player().assign({ level: 20 });
        state.players.add(player2);
        state.players.add(player2);
        assert.strictEqual(2, state.players.size);

        const decoded = new State();
        decoded.decode(state.encodeAll());
        decoded.decode(state.encode());

        assert.strictEqual(2, decoded.players.size);
        assert.deepEqual(decoded.players.toArray().map(v => v.level), [10, 20]);

        state.players.delete(player);
        assert.strictEqual(1, state.players.size);

        decoded.decode(state.encode());

        assert.strictEqual(1, decoded.players.size);
    });

    describe("delete from Set", () => {
        it("deleting schema references from SetSchema", () => {
            class Player extends Schema {
                @type("number") level: number;
            }

            class State extends Schema {
                @type({ set: Player })
                players = new SetSchema<Player>();
            }

            const state = new State();
            const player = new Player().assign({ level: 10 });
            state.players.add(player);

            const player2 = new Player().assign({ level: 20 });
            state.players.add(player2);

            const decoded = new State();
            decoded.decode(state.encodeAll());
            decoded.decode(state.encode());
            assert.strictEqual(2, decoded.players.size);

            const removed = state.players.delete(player);
            assert.strictEqual(1, state.players.size);
            assert.strictEqual(true, removed, "should return true if item has been removed successfully.");
            assert.strictEqual(false, state.players.delete(player), "should return false if item does not exist.");
            assert.strictEqual(false, state.players.delete({} as any), "should return false if item does not exist.");

            decoded.decode(state.encode());
            assert.strictEqual(1, decoded.players.size);
        });

        it("deleting raw strings from SetSchema", () => {
            class State extends Schema {
                @type({ set: "string" })
                players = new SetSchema<string>();
            }

            const state = new State();
            state.players.add("A");
            state.players.add("B");

            const decoded = new State();
            decoded.decode(state.encodeAll());
            decoded.decode(state.encode());
            assert.strictEqual(2, decoded.players.size);

            state.players.delete("A");
            decoded.decode(state.encode());
            assert.strictEqual(1, decoded.players.size);
        });
    });

    it("clear()", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @type({ set: Player })
            players = new SetSchema<Player>();
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

    it("@filter() should filter out Collection field entirely", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @filter(function(client: ClientWithSessionId, value, root) {
                return client.sessionId === "one";
            })
            @type({ set: Player })
            players = new SetSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 1 }));
        state.players.add(new Player().assign({ level: 2 }));

        const client1 = { sessionId: "one" };
        const decoded1 = new State();

        const client2 = { sessionId: "two" };
        const decoded2 = new State();

        state.encodeAll(true);
        decoded1.decode(state.applyFilters(client1, true));
        decoded2.decode(state.applyFilters(client2, true));
        state.discardAllChanges();

        assert.strictEqual(2, decoded1.players.size);
        assert.strictEqual(0, decoded2.players.size);
    });

    it("@filterChildren() should filter out schema instances", () => {
        class Player extends Schema {
            @type("number") level: number;
        }

        class State extends Schema {
            @filterChildren(function (client: ClientWithSessionId, key: number, value: Player) {
                if (client.sessionId === "one") {
                    return key % 2 === 0;
                } else {
                    return key % 2 === 1;
                }
            })
            @type({ set: Player })
            players = new SetSchema<Player>();
        }

        const state = new State();
        state.players.add(new Player().assign({ level: 1 }));
        state.players.add(new Player().assign({ level: 2 }));

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        let encoded = state.encode(undefined, undefined, true);

        const filtered1 = state.applyFilters(client1);
        const filtered2 = state.applyFilters(client2);

        const decoded1 = new State();
        decoded1.decode(filtered1)

        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.strictEqual(1, decoded1.players.size);
        assert.strictEqual(1, decoded1.players.toArray()[0].level);

        assert.strictEqual(1, decoded2.players.size);
        assert.strictEqual(2, decoded2.players.toArray()[0].level);
    });

    it("@filterChildren() should filter out primitive values", () => {
        class State extends Schema {
            @filterChildren(function (client: ClientWithSessionId, key: number, value: number) {
                if (client.sessionId === "one") {
                    return value % 2 === 0;
                } else {
                    return value % 2 === 1;
                }
            })
            @type({ set: "number" })
            numbers = new SetSchema<number>();
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

        let encoded = state.encode(undefined, undefined, true);

        const filtered1 = state.applyFilters(client1);
        const filtered2 = state.applyFilters(client2);

        const decoded1 = new State();
        decoded1.decode(filtered1)

        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.strictEqual(5, decoded1.numbers.size);
        assert.deepEqual([0, 2, 4, 6, 8], decoded1.numbers.toArray());

        assert.strictEqual(5, decoded2.numbers.size);
        assert.deepEqual([1, 3, 5, 7, 9], decoded2.numbers.toArray());
    });

    it("SetSchema.toJSON", () => {
        const set = new SetSchema();
        set.add("one");
        set.add("two");
        set.add("three");

        assert.deepEqual(['one', 'two', 'three'], set.toJSON());
    });

});
