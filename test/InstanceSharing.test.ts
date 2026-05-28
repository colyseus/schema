import * as util from "util";
import * as assert from "assert";
import { Schema, type, ArraySchema, MapSchema, SetSchema, CollectionSchema, Reflection } from "../src";
import { $changes, $refId } from "../src/types/symbols";
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

        assert.strictEqual(2, encoder.root.refCount[player[$refId]]);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(5, refCount);

        state.player1 = undefined;
        state.player2 = undefined;
        decodedState.decode(state.encode());

        assert.strictEqual(Object.keys(encoder.root.refCount).length, 5);
        for (let refId in decoder.root.refCount) {
            assert.strictEqual(decoder.root.refCount[refId], encoder.root.refCount[refId]);
        }

        console.log("Encoder =>", Schema.debugRefIds(state));
        console.log("Decoder =>", Schema.debugRefIdsFromDecoder(getDecoder(decodedState)));

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
            Object.values(decoder.root.refCount).every(refCount => refCount > 0),
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

        // Client requests to move item to player.item
        state.player.item = item;
        assert.strictEqual(1, encoder.root.refCount[item[$refId]]);

        assert.ok(item[$changes].root, "item should have 'root' reference");

        decodedState.decode(state.encode());
        assertRefIdCounts(state, decodedState);

        // Server patches item instance to change its value
        item.x = 999;

        decodedState.decode(state.encode());
        assert.strictEqual(1, decoder.root.refCount[item[$refId]]);

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

        let refIds: number[] = [];
        let current = encoder.root.allChanges.next;
        while (current) {
            if (current.changeTree !== undefined) {
                refIds.push(current.changeTree.ref[$refId]);
            }
            current = current.next;
        }

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

        const sessionId = "sessionId";

        const state = new State();
        const decodedState = new State();

        decodedState.decode(state.encode());

        state.buckets.set(sessionId, new Player());
        decodedState.decode(state.encode());

        const newSong = new Song().assign({ url: "song2" });
        state.buckets.get(sessionId).queue.push(newSong);

        console.log("refCount after adding to player queue:", getEncoder(state).root.refCount[newSong[$refId]]);
        console.log("-----");

        state.queue = new ArraySchema<Song>();
        state.queue.push(newSong);

        console.log("refCount after adding to state queue:", getEncoder(state).root.refCount[newSong[$refId]]);
        console.log("-----");

        state.playing = state.buckets.get(sessionId).queue.shift();
        console.log("refCount after shift to playing:", getEncoder(state).root.refCount[newSong[$refId]]);
        console.log("-----");

        state.queue = new ArraySchema<Song>();

        console.log("refCount after replacing state queue:", getEncoder(state).root.refCount[newSong[$refId]]);
        console.log("Song parents:", newSong[$changes].getAllParents());
        console.log("-----");

        decodedState.decode(state.encode());

        console.log(Schema.debugRefIds(state, true));

        assertRefIdCounts(state, decodedState);

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
        assertDeepStrictEqualEncodeAll(state);
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
        const activePlayerRefId = activePlayer[$refId];
        assert.strictEqual(3, encoder.root.refCount[activePlayerRefId]);

        console.log("----------------------------------------")
        console.log(Schema.debugRefIds(state))
        console.log("----------------------------------------")
        console.log("allChanges =>", Schema.debugRefIdEncodingOrder(state, "allChanges"))
        console.log("----------------------------------------")
        assertDeepStrictEqualEncodeAll(state);

        // delete 2 references
        state.activePlayers.pop();
        state.activePlayer = undefined;
        decodedState.decode(state.encode());

        // assert refCount of activePlayer again
        assert.strictEqual(1, encoder.root.refCount[activePlayerRefId]);

        console.log("----------------------------------------")
        console.log(Schema.debugRefIds(state))
        console.log("----------------------------------------")
        console.log("allChanges =>", Schema.debugRefIdEncodingOrder(state, "allChanges"))
        console.log("----------------------------------------")

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
        const activePlayerRefId = activePlayer[$refId];
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

    it("should handle removing shared references", () => {
        class Item extends Schema {
            @type("string") name: string;
            @type("string") secret: string;
        }

        class Inventory extends Schema {
            @type({ map: Item }) items = new MapSchema<Item>();
            @type("string") owner: string;
        }

        class GameState extends Schema {
            @type({ map: Inventory }) inventories = new MapSchema<Inventory>();
        }

        const state = new GameState();
        const decodedState = new GameState();

        // Create shared item
        const sharedItem = new Item().assign({
            name: "Shared Item",
            secret: "Secret Info"
        });

        // Create inventories
        const playerInv = new Inventory().assign({ owner: "Player1" });
        const shopInv = new Inventory().assign({ owner: "Shop" });
        const storageInv = new Inventory().assign({ owner: "Storage" });

        state.inventories.set("player1", playerInv);
        state.inventories.set("shop1", shopInv);
        state.inventories.set("storage1", storageInv);

        // Add shared item to multiple inventories
        playerInv.items.set("shared", sharedItem);
        shopInv.items.set("shared", sharedItem);
        storageInv.items.set("shared", sharedItem);

        // Initial encode
        decodedState.decode(state.encodeAll());

        // Phase 2: Create new inventory and move shared item
        const newInventory = new Inventory().assign({ owner: "New Owner" });
        newInventory.items.set("shared", sharedItem);

        // Replace one inventory with new one
        state.inventories.set("storage1", newInventory);

        decodedState.decode(state.encode());

        // Phase 3: Mutate shared item's property
        sharedItem.secret = "Modified Secret";

        decodedState.decode(state.encode());

        // Phase 4: Remove shared item from one inventory and add to another
        playerInv.items.delete("shared");
        shopInv.items.set("shared2", sharedItem);

        decodedState.decode(state.encode());

        // Phase 5: Create new shared item and replace existing one
        const newSharedItem = new Item().assign({
            name: "New Shared Item",
            secret: "New Secret"
        });

        // Replace shared item in all inventories
        playerInv.items.set("shared", newSharedItem);
        shopInv.items.set("shared", newSharedItem);
        newInventory.items.set("shared", newSharedItem);

        decodedState.decode(state.encode());

        // Phase 6: Remove and re-add inventories to force refId reordering
        state.inventories.delete("player1");
        state.inventories.set("player1", playerInv);

        decodedState.decode(state.encode());
        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());

        assertDeepStrictEqualEncodeAll(state, false);
    });

    describe("shared child reference counting", () => {
        class Point extends Schema {
            @type("number") x: number;
            @type("number") y: number;
            constructor(x?: number, y?: number) { super(); this.x = x; this.y = y; }
        }

        // Capture decoder warnings ("trying to remove refId..." / "refId not
        // found") for the whole block — these must never be emitted.
        let decoderWarnings: string[] = [];
        const originalWarn = console.warn;
        beforeEach(() => {
            decoderWarnings = [];
            console.warn = (...args: any[]) => decoderWarnings.push(args.map(String).join(" "));
        });
        afterEach(() => { console.warn = originalWarn; });

        // No decoder warnings + encoder/decoder ref agreement (counts and no
        // orphans — `assertRefIdCounts` covers both).
        function assertNoLeak(state: Schema, decoded: Schema) {
            assert.deepStrictEqual(decoderWarnings, [], `decoder emitted warning(s): ${decoderWarnings.join(" | ")}`);
            assertRefIdCounts(state, decoded);
        }

        it("array element shared into a field, then shifted out and array replaced", () => {
            class Mover extends Schema {
                @type([Point]) moves = new ArraySchema<Point>();
                @type(Point) targetMove: Point;
            }
            class State extends Schema {
                @type({ map: Mover }) movers = new MapSchema<Mover>();
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const mover = new Mover();
            state.movers.set("p", mover);
            const a = new Point(1, 1), b = new Point(2, 2);
            mover.moves.push(a, b);
            mover.targetMove = b; // SHARE: `b` is both moves[1] and targetMove
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            // single patch: shift `a` out, then replace the array; `b` survives via targetMove
            mover.moves.shift();
            mover.moves = new ArraySchema<Point>(new Point(3, 3));
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            // `b` must still be live & mutable
            mover.targetMove.x = 99;
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.strictEqual(decoded.movers.get("p").targetMove.x, 99);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("map value shared into a field, then map replaced (value survives)", () => {
            class Holder extends Schema {
                @type({ map: Point }) map = new MapSchema<Point>();
                @type(Point) ref: Point;
            }
            class State extends Schema {
                @type(Holder) holder = new Holder();
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const c = new Point(1, 1);
            state.holder.map.set("x", new Point(0, 0));
            state.holder.map.set("y", c);
            state.holder.ref = c; // share `c`
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.holder.map = new MapSchema<Point>(); // replace whole map
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.holder.ref = undefined; // drop survivor -> `c` fully collected
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("shared container replaced while still referenced by another field", () => {
            class State extends Schema {
                @type([Point]) a = new ArraySchema<Point>();
                @type([Point]) b = new ArraySchema<Point>();
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const shared = new ArraySchema<Point>(new Point(1, 1), new Point(2, 2));
            state.a = shared;
            state.b = shared; // same array instance in two fields
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            // replace one field; the container survives via the other -> its children must stay
            state.a = new ArraySchema<Point>(new Point(3, 3));
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            // drop the last reference -> container + children collected
            state.b = new ArraySchema<Point>();
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("repeated shift + replace with a shared survivor (per-patch discard)", () => {
            class Mover extends Schema {
                @type([Point]) moves = new ArraySchema<Point>();
                @type(Point) targetMove: Point;
            }
            class State extends Schema {
                @type(Mover) mover = new Mover();
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);
            decoded.decode(state.encodeAll());
            getEncoder(state).discardChanges();

            state.mover.moves.push(new Point(0, 0));
            state.mover.targetMove = state.mover.moves[0];
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            for (let i = 0; i < 50; i++) {
                state.mover.moves.shift();
                state.mover.moves = new ArraySchema<Point>(new Point(i, i), new Point(i + 1, i + 1));
                state.mover.targetMove = state.mover.moves[0]; // share the new survivor
                decoded.decode(state.encode());
                assertNoLeak(state, decoded);
            }

            assertDeepStrictEqualEncodeAll(state);
        });

        it("encodeAll() without discardChanges() then replace must not leak", () => {
            //
            // `SchemaSerializer.getFullState()` calls `encodeAll()` WITHOUT
            // `discardChanges()`. A subsequent collection-field replacement
            // can arrive as a plain ADD (a pending ADD not upgraded to
            // DELETE_AND_ADD), so the decoder must still release the old
            // container instead of leaking it (and its children).
            //
            class State extends Schema {
                @type([Point]) arr = new ArraySchema<Point>();
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);

            state.arr.push(new Point(1, 1), new Point(2, 2));
            decoded.decode(state.encodeAll()); // NO discardChanges()

            state.arr = new ArraySchema<Point>(new Point(3, 3));
            decoded.decode(state.encode());

            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());
        });

        it("SetSchema field replaced (shared element survives)", () => {
            class State extends Schema {
                @type({ set: Point }) s = new SetSchema<Point>();
                @type(Point) ref: Point;
            }
            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const shared = new Point(1, 1);
            state.s.add(new Point(0, 0));
            state.s.add(shared);
            state.ref = shared; // share a set element into a field
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.s = new SetSchema<Point>([new Point(9, 9)]); // replace whole set
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.ref = undefined; // drop survivor
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("CollectionSchema field replaced (shared element survives)", () => {
            class State extends Schema {
                @type({ collection: Point }) c = new CollectionSchema<Point>();
                @type(Point) ref: Point;
            }
            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const shared = new Point(1, 1);
            state.c.add(new Point(0, 0));
            state.c.add(shared);
            state.ref = shared;
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.c = new CollectionSchema<Point>(); // replace whole collection
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.ref = undefined;
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("replace a collection field on a Schema nested in a MapSchema (shared child survives)", () => {
            class Inner extends Schema { @type([Point]) items = new ArraySchema<Point>(); }
            class State extends Schema {
                @type({ map: Inner }) m = new MapSchema<Inner>();
                @type(Point) ref: Point;
            }
            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const inner = new Inner();
            state.m.set("k", inner);
            inner.items.push(new Point(1, 1), new Point(2, 2));
            state.ref = inner.items[1]; // share a deeply-nested element into a top-level field
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            inner.items = new ArraySchema<Point>(new Point(3, 3)); // replace the nested collection field
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            state.ref = undefined;
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("delete the containing Map entry while a nested child is shared into a field", () => {
            class Inner extends Schema { @type([Point]) items = new ArraySchema<Point>(); }
            class State extends Schema {
                @type({ map: Inner }) m = new MapSchema<Inner>();
                @type(Point) ref: Point;
            }
            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const inner = new Inner();
            state.m.set("k", inner);
            inner.items.push(new Point(1, 1), new Point(2, 2));
            state.ref = inner.items[0];
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            state.m.delete("k"); // destroy the whole subtree; `ref` still holds one child
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            state.ref = undefined; // now the survivor is fully collected
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("re-reference (resurrect) a still-alive shared instance after its collection is replaced", () => {
            class State extends Schema {
                @type([Point]) arr = new ArraySchema<Point>();
                @type(Point) held: Point;
            }
            const state = new State();
            const decoded = createInstanceFromReflection(state);

            const shared = new Point(1, 1);
            state.arr.push(shared);
            state.held = shared; // keep `shared` alive independently of the array
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            // replace the array; `shared` survives via `held`
            state.arr = new ArraySchema<Point>(new Point(9, 9));
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);

            // resurrect: push the still-alive instance back into the (new) array
            state.arr.push(shared);
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            // mutate it to prove it's still a valid, decodable reference
            shared.x = 42;
            decoded.decode(state.encode());
            assertNoLeak(state, decoded);
            assert.strictEqual(decoded.held.x, 42);
            assert.strictEqual(decoded.arr[decoded.arr.length - 1].x, 42);

            assertDeepStrictEqualEncodeAll(state);
        });
    });

});