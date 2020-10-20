import * as assert from "assert";

import { State, Player } from "./Schema";
import { MapSchema } from "../src";

import { assertExecutionTime } from "./helpers/test_helpers";


describe("Benchmark Test", () => {
    const state = new State();

    beforeEach(() => {
        state.mapOfPlayers = new MapSchema();
        for (let i = 0; i < 200; i++) {
            state.mapOfPlayers.set("p" + i, new Player().assign({
                name: `Player ${i}`,
                x: i * 100,
                y: i * 100
            }))
        }
    });

    it("#encodeAll()", () => {
        assertExecutionTime(5, () => state.encodeAll());
    });

    it("#encode()", () => {
        assertExecutionTime(1, () => {
            for (let i = 0; i < 200; i++) {
                const player = state.mapOfPlayers.get("p" + i);
                player.x = i;
                player.y = i;
            }
            state.encode();
        });
    });

    it("#decode() 200 entries", () => {
        for (let i = 0; i < 200; i++) {
            const player = state.mapOfPlayers.get("p" + i);
            player.x++;
            player.y++;
        }
        const encoded = state.encode();

        assertExecutionTime(6, () => {
            const decoded = new State();
            decoded.decode(encoded);
        });
    });

    it("#decode() 10 entries", () => {
        const smallState = new State();
        smallState.mapOfPlayers = new MapSchema();
        for (let i = 0; i < 10; i++) {
            state.mapOfPlayers.set("p" + i, new Player().assign({
                name: `Player ${i}`,
                x: i * 100,
                y: i * 100
            }))
        }

        const encoded = state.encode();

        assertExecutionTime(5, () => {
            const decoded = new State();
            decoded.decode(encoded);
        });
    });

});