import * as assert from "assert";
import { Schema, type, ArraySchema, MapSchema, Reflection } from "../src";
import { $changes } from "../src/types/symbols";
import { assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getCallbacks, getDecoder, getEncoder } from "./Schema";

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
        state.player1 = player;
        state.player2 = player;

        const decodedState = new State();
        decodedState.decode(state.encodeAll());

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(5, refCount);

        state.player1 = undefined;
        state.player2 = undefined;
        decodedState.decode(state.encode());

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 2, newRefCount);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("sharing items inside ArraySchema", () => {
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
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();

        decodedState.decode(state.encode());

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);

        assertDeepStrictEqualEncodeAll(state);
    });

    it("clearing ArraySchema", () => {
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
        decodedState.decode(state.encode());

        const decoder = getDecoder(decodedState);

        const refCount = decoder.root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.clear();

        decodedState.decode(state.encode());

        const newRefCount = decoder.root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);

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

        assert.strictEqual(numRefs, decoder.root.refs.size, "should've dropped reference to previous ArraySchema");
        assert.strictEqual(
            true,
            Object.values(decoder.root.refCounts).every(refCount => refCount > 0),
            "all refCount's should have a valid number."
        );

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
        const { $state } = getCallbacks(decodedState);

        let numHpChangeTriggered = 0;
        let numMpChangeTriggered = 0;
        $state.player1.listen('hp', () => numHpChangeTriggered++);
        $state.player2.listen('hp', () => numHpChangeTriggered++);
        $state.player1.listen('mp', () => numMpChangeTriggered++);
        $state.player2.listen('mp', () => numMpChangeTriggered++);

        decodedState.decode(state.encode());

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

            assertDeepStrictEqualEncodeAll(state);
        });

    });

});