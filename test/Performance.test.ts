import * as assert from "assert";
import { State, Player } from "./Schema";
import { ArraySchema, MapSchema } from "../src";
import { IS_COVERAGE } from "./helpers/test_helpers";

const getRandomNumber = (max: number = 2000) => Math.floor(Math.random() * max);

function assertExecutionTime(cb: Function, message: string, threshold: number) {
    const now = Date.now();
    cb();
    const diff = Date.now() - now;

    console.log(`${message} took ${diff}ms`)

    // allow increased threshold on code coverage
    if (IS_COVERAGE) { threshold *= 2; }

    assert.ok(diff <= threshold, `${message} exceeded ${threshold}ms. took: ${diff}ms`);
}

describe("Performance", () => {
    it("ArraySchema", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();

        const totalItems = 10000;

        assertExecutionTime(() => {
            for (let i = 0; i < totalItems; i++) {
                state.arrayOfPlayers.push(new Player("Player " + i, getRandomNumber(), getRandomNumber()));
            }
        }, `inserting ${totalItems} items to array`, 1500); // 1200, TODO: improve this!

        assertExecutionTime(() => state.encode(), `encoding ${totalItems} array entries`, 250); // 190

        const player: Player = state.arrayOfPlayers[Math.round(totalItems / 2)];
        player.x = getRandomNumber();
        player.y = getRandomNumber();

        // TODO: improve this value
        assertExecutionTime(() => state.encode(), "encoding a single array item change", 60); // 5
    });

    it("MapSchema", function () {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();

        const totalItems = 10000;

        assertExecutionTime(() => {
            for (let i = 0; i < totalItems; i++) {
                state.mapOfPlayers["player" + i] = new Player("Player " + i, getRandomNumber(), getRandomNumber());
            }
        }, `inserting ${totalItems} items to map`, 3500); // 2700, TODO: improve this value!

        assertExecutionTime(() => state.encode(), `encoding ${totalItems} map entries`, 300); // 150

        const player: Player = state.mapOfPlayers[`player${Math.floor(totalItems / 2)}`];
        player.x = getRandomNumber();
        player.y = getRandomNumber();

        // TODO: improve this value
        assertExecutionTime(() => state.encode(), "encoding a single map item change", 60); // 15
    });
});