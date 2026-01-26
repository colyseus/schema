import * as assert from "assert";
import { State, Player } from "./Schema";
import { ArraySchema, Encoder, MapSchema } from "../src";
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
    let originalBufferSize: number = Encoder.BUFFER_SIZE;

    // Increase buffer size for performance tests
    before(() => Encoder.BUFFER_SIZE = 512 * 1024);
    after(() => Encoder.BUFFER_SIZE = originalBufferSize);

    it("ArraySchema", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();

        const totalItems = 10000;

        assertExecutionTime(() => {
            for (let i = 0; i < totalItems; i++) {
                state.arrayOfPlayers.push(new Player("Player " + i, getRandomNumber(), getRandomNumber()));
            }
        }, `inserting ${totalItems} items to array`, 80);

        assertExecutionTime(() => state.encode(), `encoding ${totalItems} array entries`, 50);

        const player: Player = state.arrayOfPlayers[Math.round(totalItems / 2)];
        player.x = getRandomNumber();
        player.y = getRandomNumber();

        assertExecutionTime(() => state.encode(), "encoding a single array item change", 10);
    });

    it("MapSchema", function () {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();

        const totalItems = 10000;

        assertExecutionTime(() => {
            for (let i = 0; i < totalItems; i++) {
                state.mapOfPlayers.set("player" + i, new Player("Player " + i, getRandomNumber(), getRandomNumber()));
            }
        }, `inserting ${totalItems} items to map`, 80);

        assertExecutionTime(() => state.encode(), `encoding ${totalItems} map entries`, 50);

        const player: Player = state.mapOfPlayers.get(`player${Math.floor(totalItems / 2)}`);
        player.x = getRandomNumber();
        player.y = getRandomNumber();

        assertExecutionTime(() => state.encode(), "encoding a single map item change", 10);
    });
});