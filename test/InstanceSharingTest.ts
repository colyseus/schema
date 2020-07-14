import * as assert from "assert";
import { type } from "../src/annotations";
import { Schema, ArraySchema, MapSchema } from "../src";

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
        assert.equal(5, decodedState['$changes'].root.refs.size);

        state.player2 = player;

        const encoded = state.encode();

        // TODO: improve me! ideally, it should be 3 bytes.
        assert.equal(3, encoded.length);

        decodedState.decode(encoded);
        assert.deepEqual({
            player1: { position: { x: 10, y: 10 } },
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());
        assert.equal(5, decodedState['$changes'].root.refs.size);

        state.player2 = player;
        state.player1 = undefined;

        decodedState.decode(state.encode());
        assert.deepEqual({
            player2: { position: { x: 10, y: 10 } },
            arrayOfPlayers: [],
            mapOfPlayers: {}

        }, decodedState.toJSON());

        assert.equal(5, decodedState['$changes'].root.refs.size, "Player and Position structures should remain.");
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
        assert.equal(5, refCount);
        // console.log(decodedState['$changes'].root.refs);

        state.player1 = undefined;
        state.player2 = undefined;
        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        // console.log(decodedState['$changes'].root.refs);
        assert.equal(refCount - 2, newRefCount);
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
        assert.equal(7, refCount);

        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();
        state.arrayOfPlayers.pop();

        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        assert.equal(refCount - 4, newRefCount);
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
        assert.equal(7, refCount);

        state.arrayOfPlayers.clear();

        decodedState.decode(state.encode());

        const newRefCount = decodedState['$changes'].root.refs.size;
        assert.equal(refCount - 4, newRefCount);
    });
});