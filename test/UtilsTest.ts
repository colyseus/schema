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
            '[{"ref":"State","refId":0,"operations":{"mapOfPlayers":"ADD"}},{"ref":"Player","refId":2,"operations":{"name":"ADD","x":"ADD","y":"ADD"}},{"ref":"MapSchema","refId":1,"operations":{"one":"ADD"}}]'
        );

        // discard changes
        state.encode();

        delete state.mapOfPlayers['one'];
        dump = dumpChanges(state);

        assert.equal(
            JSON.stringify(dump),
            '[{"ref":"MapSchema","refId":1,"operations":{"one":"DELETE"}}]'
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
            '[{"ref":"State","refId":0,"operations":{"arrayOfPlayers":"ADD"}},{"ref":"Player","refId":2,"operations":{"name":"ADD","x":"ADD","y":"ADD"}},{"ref":"ArraySchema","refId":1,"operations":{"0":"ADD","1":"ADD"}},{"ref":"Player","refId":3,"operations":{"name":"ADD","x":"ADD","y":"ADD"}}]',
        );

        // discard changes
        state.encode();

        state.arrayOfPlayers.splice(1);
        dump = dumpChanges(state);
        console.log(JSON.stringify(dump));

        assert.equal(
            JSON.stringify(dump),
            '[{"ref":"State","refId":0,"operations":{"arrayOfPlayers":"ADD"}},{"ref":"Player","refId":2,"operations":{"name":"ADD","x":"ADD","y":"ADD"}},{"ref":"ArraySchema","refId":1,"operations":{"0":"ADD","1":"ADD"}},{"ref":"Player","refId":3,"operations":{"name":"ADD","x":"ADD","y":"ADD"}}]',
        );
    });

});