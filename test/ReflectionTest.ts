import * as assert from "assert";

import { State } from "./Schema";
import { Reflection } from "../src/annotations";

describe("Reflection", () => {

    it("should encode schema definitions", () => {
        const state = new State();
        const reflected = new Reflection();
        assert.equal(
            JSON.stringify(reflected.decode(Reflection.encode(state))),
            '{"types":[{"id":1,"fields":[{"name":"name","type":"string"},{"name":"x","type":"number"},{"name":"y","type":"number"}]},{"id":0,"fields":[{"name":"fieldString","type":"string"},{"name":"fieldNumber","type":"number"},{"name":"player","type":"ref","referencedType":1},{"name":"arrayOfPlayers","type":"array","referencedType":1},{"name":"mapOfPlayers","type":"map","referencedType":1}]}]}'
        );
    });

});