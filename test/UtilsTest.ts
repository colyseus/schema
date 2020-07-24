import * as assert from "assert";

import { State, Player } from "./Schema";
import { MapSchema, dumpChanges, ArraySchema } from "../src";

describe("Utils Test", () => {

    it("dumpChanges -> map", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();
        state.mapOfPlayers['one'] = new Player("One", 1, 1);

        let dump: any = dumpChanges(state);
        assert.equal(
            JSON.stringify(dump),
            '{"mapOfPlayers":{"one":{"name":"One","x":1,"y":1}}}'
        );

        // discard changes
        state.encode();

        delete state.mapOfPlayers['one'];
        dump = dumpChanges(state);

        assert.equal(
            JSON.stringify(dump),
            '{"mapOfPlayers":{}}'
        );
    });

    it("dumpChanges -> array", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 1, 1));
        state.arrayOfPlayers.push(new Player("Two", 2, 2));

        let dump: any = dumpChanges(state);
        assert.equal(
            JSON.stringify(dump),
            '{"arrayOfPlayers":[{"name":"One","x":1,"y":1},{"name":"Two","x":2,"y":2}]}',
        );

        // discard changes
        state.encode();

        state.arrayOfPlayers.splice(1);
        dump = dumpChanges(state);

        assert.equal(
            JSON.stringify(dump),
            '{"arrayOfPlayers":[{"name":"One","x":1,"y":1}]}',
        );
    });

});