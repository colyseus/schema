import * as assert from "assert";

import { State, Player } from "./Schema";
import { MapSchema, dumpChanges, ArraySchema } from "../src";

describe("Utils Test", () => {

    describe("dumpChanges", () => {
        // it("Should not throw", () => {
        //     const state = new State();
        // });

        it("MapSchema", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();

            assert.doesNotThrow(() => dumpChanges(state));

            state.mapOfPlayers['one'] = new Player("One", 1, 1);

            let dump: any = dumpChanges(state);
            assert.strictEqual(
                JSON.stringify(dump),
                '{"mapOfPlayers":{"one":{"name":"One","x":1,"y":1}}}'
            );

            // discard changes
            state.encode();

            delete state.mapOfPlayers['one'];
            dump = dumpChanges(state);

            assert.strictEqual(
                JSON.stringify(dump),
                '{"mapOfPlayers":{}}'
            );
        });

        it("ArraySchema", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema<Player>();
            state.arrayOfPlayers.push(new Player("One", 1, 1));
            state.arrayOfPlayers.push(new Player("Two", 2, 2));

            assert.doesNotThrow(() => dumpChanges(state));

            let dump: any = dumpChanges(state);
            assert.strictEqual(
                JSON.stringify(dump),
                '{"arrayOfPlayers":[{"name":"One","x":1,"y":1},{"name":"Two","x":2,"y":2}]}',
            );

            // discard changes
            state.encode();

            state.arrayOfPlayers.splice(1);
            dump = dumpChanges(state);

            assert.strictEqual(
                JSON.stringify(dump),
                '{"arrayOfPlayers":[{"name":"One","x":1,"y":1}]}',
            );
        });

    });

});