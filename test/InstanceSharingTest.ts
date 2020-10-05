import * as assert from "assert";
import { Schema, type, ArraySchema, MapSchema } from "../src";

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

        assert.deepEqual({
            player1: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}
        }, decodedState.toJSON());
        assert.strictEqual(5, decodedState['$changes'].root.refs.size);

        state.player2 = player;

        const encoded = state.encode();
        assert.strictEqual(2, encoded.length);

        decodedState.decode(encoded);
        assert.deepEqual({
            player1: { position: { x: 10, y: 10 } },
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());
        assert.strictEqual(5, decodedState['$changes'].root.refs.size);

        state.player2 = player;
        state.player1 = undefined;

        decodedState.decode(state.encode());
        assert.deepEqual({
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());

        assert.strictEqual(5, decodedState['$changes'].root.refs.size, "Player and Position structures should remain.");
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

        const refCount = decodedState['$changes'].root.refs.size;
        assert.strictEqual(5, refCount);
        // console.log(decodedState['$changes'].root.refs);

        state.player1 = undefined;
        state.player2 = undefined;
        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        // console.log(decodedState['$changes'].root.refs);
        assert.strictEqual(refCount - 2, newRefCount);
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

        const refCount = decodedState['$changes'].root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();

        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);
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

        const refCount = decodedState['$changes'].root.refs.size;
        assert.strictEqual(7, refCount);

        state.arrayOfPlayers.clear();

        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        assert.strictEqual(refCount - 4, newRefCount);
    });

    it("replacing ArraySchema should drop previous refId", () => {
        class State extends Schema {
            @type(["number"]) arrayOfNumbers: number[] = new ArraySchema<number>();
        }

        const state = new State();
        state.arrayOfNumbers.push(1, 2, 3);

        const decodedState = new State();
        decodedState.decode(state.encode());

        const getRefCount = () => decodedState['$changes'].root.refs.size;
        const firstCount = getRefCount();

        state.arrayOfNumbers = [4, 5, 6];
        decodedState.decode(state.encode());

        assert.strictEqual(firstCount, getRefCount(), "should've dropped reference to previous ArraySchema");
    });

    it("replacing ArraySchema should drop children's refId's", () => {
        const state = new State();
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 20, y: 30 }) }));

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        decodedState.decode(state.encode());

        const getRefCount = () => decodedState['$changes'].root.refs.size;
        const firstCount = getRefCount();

        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));
        state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 20, y: 30 }) }));

        decodedState.decode(state.encode());

        // force garbage collection.
        // decodedState['$changes'].root.garbageCollectDeletedRefs();

        assert.strictEqual(firstCount, getRefCount(), "should've dropped reference to previous ArraySchema");
        assert.strictEqual(
            true,
            Object.values(decodedState['$changes'].root.refCounts).every(refCount => refCount > 0),
            "all refCount's should have a valid number."
        );
    });
});