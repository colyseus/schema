import * as assert from "assert";
import { Schema, type, ArraySchema, MapSchema, Reflection } from "../src";
import { $changes } from "../src/types/symbols";
import { assertDeepStrictEqualEncodeAll, assertRefIdCounts, createInstanceFromReflection, getCallbacks, getDecoder, getEncoder } from "./Schema";

describe("Instance sharing", () => {
    class Position extends Schema {
        @type("number") x: number;
        @type("number") y: number;
    }

    class Player extends Schema {
        @type(Position) position = new Position();
    }

    class State extends Schema {
        @type(Player) player1: Player;
        @type(Player) player2: Player;
        @type([Player]) arrayOfPlayers = new ArraySchema<Player>();
        @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
    }

    it("should allow moving an instance from one field to another", () => {
        const player = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });

        const state = new State();
        state.player1 = player;

        const decodedState = new State();
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);

        assert.deepStrictEqual({
            player1: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}
        }, decodedState.toJSON());

        assert.strictEqual(5, decoder.root.refs.size);

        const encoder = getEncoder(state);

        state.player2 = player;

        const encoded = state.encode();
        assert.strictEqual(2, encoded.length);

        decodedState.decode(encoded);
        assert.deepStrictEqual({
            player1: { position: { x: 10, y: 10 } },
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());
        assert.strictEqual(5, decoder.root.refs.size);

        state.player2 = player;
        state.player1 = undefined;

        decodedState.decode(state.encode());
        assert.deepStrictEqual({
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());

        assertRefIdCounts(state, decodedState);

        assert.strictEqual(5, decoder.root.refs.size, "Player and Position structures should remain.");
        assertDeepStrictEqualEncodeAll(state);
    });

    it("should drop reference of deleted instance when decoding", () => {
        const player = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });

        const state = new State();
        const encoder = getEncoder(state);
        state.player1 = player;
        state.player2 = player;

        const decodedState = new State();
        decodedState.decode(state.encodeAll());

        const decoder = getDecoder(decodedState);

        assert.strictEqual(2, encoder.root.refCount[player[$changes].refId]);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(5, refCount);

        state.player1 = undefined;
        state.player2 = undefined;
        decodedState.decode(state.encode());

        assert.strictEqual(Object.keys(encoder.root.refCount).length, 5);
        for (let refId in decoder.root.refCounts) {
            assert.strictEqual(decoder.root.refCounts[refId], encoder.root.refCount[refId]);
        }
        assertRefIdCounts(state, decodedState);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("sharing items inside ArraySchema", () => {
        const state = new State();
        const encoder = getEncoder(state);

        const player1 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);

        const player2 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player2);

        const decodedState = new State();
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("clearing ArraySchema", () => {
        const state = new State();
        const encoder = getEncoder(state);

        const player1 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);

        const player2 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player2);

        const decodedState = new State();
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.clear();

        decodedState.decode(state.encode());

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);

        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("adding late reference to Root should keep correct reference counting", () => {
        /**
         * This test only starts tracking references after the first .encode() call.
         */
        const state = new State();

        const player1 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);
        state.arrayOfPlayers.push(player1);

        const player2 = new Player().assign({
            position: new Position().assign({
                x: 10, y: 10
            })
        });
        state.arrayOfPlayers.push(player2);

        const decodedState = new State();
        // const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.clear();

        decodedState.decode(state.encode());

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);

        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("replacing ArraySchema should drop previous refId", () => {
        class State extends Schema {
            @type(["number"]) arrayOfNumbers: number[] = new ArraySchema<number>();
        }

        const state = new State();
        state.arrayOfNumbers.push(1, 2, 3);

        const decodedState = new State();
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);

        const getRefCount = () => decoder.root.refs.size;
        const firstCount = getRefCount();

        state.arrayOfNumbers = [4, 5, 6];
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual(firstCount, getRefCount(), "should've dropped reference to previous ArraySchema");

        assertDeepStrictEqualEncodeAll(state);
    });

    it("replacing ArraySchema should drop children's refId's", () => {
        const state = new State();
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 20, y: 30 }) }));

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);
        const numRefs = decoder.root.refs.size;

        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 20, y: 30 }) }));

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual(numRefs, decoder.root.refs.size, "should've dropped reference to previous ArraySchema");
        assert.strictEqual(
            true,
            Object.values(decoder.root.refCounts).every(refCount => refCount > 0),
            "all refCount's should have a valid number."
        );

        assertDeepStrictEqualEncodeAll(state);
    });

    it("deleting a shared reference should not remove 'root' from it", async () => {
        class Metadata extends Schema {
            @type('string') meta: string = 'none';
        }

        class Item extends Schema {
            @type('number') x: number = 0;
            @type(Metadata) metadata: Metadata// = new Metadata();
        }

        class Player extends Schema {
            @type(Item) item: Item | null = null;
        }

        class State extends Schema {
            @type(Player) player: Player;
            @type(Item) item: Item;
        }

        const state = new State();
        const decodedState = new State();

        const encoder = getEncoder(state);
        const decoder = getDecoder(decodedState);

        decodedState.decode(state.encode());

        const item = new Item();
        state.player = new Player();

        state.item = item;
        state.player.item = item;
        state.player.item = null;

        assert.ok(item[$changes].root, "item should have 'root' reference");

        // randomly set and unset 'item' references
        let i1 = setInterval(() => state.player.item = item, 1);
        let i2 = setInterval(() => state.player.item = null, 2);
        let i3 = setInterval(() => decodedState.decode(state.encode()), 3);

        let i4 = setInterval(() => state.item = item, 4);
        let i5 = setInterval(() => state.item = null, 5);

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                clearInterval(i1);
                clearInterval(i2);
                clearInterval(i3);

                clearInterval(i4);
                clearInterval(i5);
                resolve();
            }, 100);
        });

        // .... Clent spams the same thing multiple times
        // (bug: Eventually, decoding warning: "trying to remove refId '55' with 0 refCount")

        state.item = null;

        // Client requests to move myA to myB
        state.player.item = item;
        assert.strictEqual(1, encoder.root.refCount[item[$changes].refId]);

        assert.ok(item[$changes].root, "item should have 'root' reference");

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        // Server patches item instance to change its value
        item.x = 999;

        decodedState.decode(state.encode());
        assert.strictEqual(1, decoder.root.refCounts[item[$changes].refId]);

        assert.strictEqual(999, decodedState.player.item.x);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("remove from 'all changes' only if reference count is 0", async () => {
        class Metadata extends Schema {
            @type('string') meta: string = 'none';
        }

        class Item extends Schema {
            @type('number') x: number = 0;
            @type(Metadata) metadata: Metadata = new Metadata();
        }

        class Player extends Schema {
            @type(Item) item: Item | null = null;
        }

        class State extends Schema {
            @type(Player) player: Player;
            @type(Item) item: Item;
        }

        const state = new State();
        const decodedState = new State();

        const encoder = getEncoder(state);
        decodedState.decode(state.encode());

        const item = new Item();
        state.player = new Player();

        // randomly set and unset 'item' references
        let i1 = setInterval(() => state.player.item = item, 1);
        let i2 = setInterval(() => state.player.item = null, 2);

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                clearInterval(i1);
                clearInterval(i2);

                resolve();
            }, 100);
        });

        state.player.item = item;

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        const refIds = encoder.root.allChanges
            .filter(changeTree => changeTree !== undefined)
            .map(changeTree => changeTree.refId);

        assert.deepStrictEqual([0, 1, 2, 3], refIds, "must include all refId's");

        assertDeepStrictEqualEncodeAll(state);
    });

    it("should allow having shared Schema class with no fields", () => {
        class Quest extends Schema { }
        class QuestOne extends Quest {
            @type("string") name: string;
        }

        class State extends Schema {
            @type({ map: Quest }) quests = new MapSchema<Quest>();
        }

        const state = new State();
        state.quests.set('one', new QuestOne().assign({ name: "one" }));

        const decodedState = new State();
        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual("one", (decodedState.quests.get('one') as QuestOne).name);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("client-side: should trigger on all shared places", () => {
        class Player extends Schema {
            @type("number") hp: number;
            @type("number") mp: number;
        }

        class State extends Schema {
            @type(Player) player1: Player;
            @type(Player) player2: Player;
        }

        const state = new State();

        const player = new Player().assign({ hp: 100 });;
        state.player1 = player
        state.player2 = player;

        const decodedState = createInstanceFromReflection(state);
        const $ = getCallbacks(decodedState);

        let numHpChangeTriggered = 0;
        let numMpChangeTriggered = 0;
        $(decodedState).player1.listen('hp', () => numHpChangeTriggered++);
        $(decodedState).player2.listen('hp', () => numHpChangeTriggered++);
        $(decodedState).player1.listen('mp', () => numMpChangeTriggered++);
        $(decodedState).player2.listen('mp', () => numMpChangeTriggered++);

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.strictEqual(decodedState.player1.hp, 100);
        assert.strictEqual(decodedState.player2.hp, 100);
        assert.strictEqual(2, numHpChangeTriggered);
        assert.strictEqual(0, numMpChangeTriggered);

        assertDeepStrictEqualEncodeAll(state);
    });

    describe("change tracking", () => {
        it("should track change of cleared container + modified instance", () => {
            class Player extends Schema {
                @type("number") hp: number;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
                @type(Player) leader: Player;
            }

            const state = new State();
            state.players.set("one", new Player().assign({ hp: 100 }));
            state.players.set("two", new Player().assign({ hp: 100 }));
            state.leader = state.players.get("one");

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

            state.leader.hp = 50;
            state.players.clear();

            decodedState.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
            assertRefIdCounts(state, decodedState);

            assertDeepStrictEqualEncodeAll(state);
        });

    });

    it("replacing collection of items while keeping a reference to an item", () => {
        class Song extends Schema {
            @type("string") url: string;
        }

        class Player extends Schema {
            @type([Song]) queue = new ArraySchema<Song>();
        }

        class State extends Schema {
            @type(Song) playing: Song = new Song();
            @type([Song]) queue = new ArraySchema<Song>();
            @type({ map: Player }) buckets = new MapSchema<Player>();
        }

        const sessionId = "";

        const state = new State();
        const decodedState = new State();

        decodedState.decode(state.encode());

        state.buckets.set(sessionId, new Player());
        decodedState.decode(state.encode());

        const newSong = new Song().assign({ url: "song2" });
        state.buckets.get(sessionId).queue.push(newSong);

        state.queue = new ArraySchema<Song>();
        state.queue.push(newSong);

        state.playing = state.buckets.get(sessionId).queue.shift();
        state.queue = new ArraySchema<Song>();

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
    });

    it("decoder: should increment refId count of deep shared instances", () => {
        class Position extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class Player extends Schema {
            @type(Position) position = new Position();
        }
        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
            @type([Player]) activePlayers = new ArraySchema<Player>();
            @type(Player) activePlayer: Player;
        }

        const state = new State();
        const encoder = getEncoder(state);
        const decodedState = new State();

        state.players.set("one", new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.players.set("two", new Player().assign({ position: new Position().assign({ x: 30, y: 40 }) }));
        decodedState.decode(state.encodeAll());

        // create +2 references to the same instance
        const activePlayer = state.players.get("one");
        state.activePlayers.push(activePlayer);
        state.activePlayer = activePlayer;

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        // assert refCount of activePlayer
        const activePlayerRefId = activePlayer[$changes].refId;
        assert.strictEqual(3, encoder.root.refCount[activePlayerRefId]);

        // delete 2 references
        state.activePlayers.pop();
        state.activePlayer = undefined;
        decodedState.decode(state.encode());

        // assert refCount of activePlayer again
        assert.strictEqual(1, encoder.root.refCount[activePlayerRefId]);

        assertDeepStrictEqualEncodeAll(state);
    })

    it("ArraySchema.clear() should update instance ref count", () => {
        class Position extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }
        class Player extends Schema {
            @type("string") name: string;
            @type(Position) position = new Position();
        }
        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
            @type([Player]) activePlayers = new ArraySchema<Player>();
            @type(Player) activePlayer: Player;
        }

        const state = new State();
        const encoder = getEncoder(state);
        const decodedState = new State();

        state.players.set("one", new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.players.set("two", new Player().assign({ position: new Position().assign({ x: 30, y: 40 }) }));
        decodedState.decode(state.encodeAll());

        // create +2 references to the same instance
        const activePlayer = state.players.get("one");
        state.activePlayers.push(activePlayer);
        state.activePlayer = activePlayer;

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        // assert refCount of activePlayer
        const activePlayerRefId = activePlayer[$changes].refId;
        assert.strictEqual(3, encoder.root.refCount[activePlayerRefId]);

        // delete 2 references
        state.activePlayers.clear();
        state.activePlayer = undefined;

        // update active player and its children
        activePlayer.name = "new name";
        activePlayer.position.x = 100;
        activePlayer.position.y = 100;

        decodedState.decode(state.encode());

        // assert refCount of activePlayer again
        assert.strictEqual(1, encoder.root.refCount[activePlayerRefId]);

        assertDeepStrictEqualEncodeAll(state);
    })

});