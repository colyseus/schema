import * as assert from "assert";
import { addExtension, pack } from "msgpackr";

import { Player, State } from "./Schema";
import { ArraySchema, MapSchema } from "../src";
import { Schema } from "../lib";

addExtension({
    Class: State,
    type: 0,
    read(datum: any): any {
        return datum;
    },
    write(instance: any): any {
        return instance.toJSON();
    }
});

describe("Compatibility", () => {
    const targetState = {"fieldString":"Hello world!","fieldNumber":10,"player":{"name":"Jake","x":100,"y":100},"arrayOfPlayers":[{"name":"arr1","x":1,"y":1},{"name":"arr2","x":2,"y":2}],"mapOfPlayers":{"one":{"name":"One","x":1,"y":1},"two":{"name":"Two","x":2,"y":2}}};
    let state = new State();

    before(() => {
        state.fieldNumber = 10;
        state.fieldString = "Hello world!";
        state.player = new Player("Jake", 100, 100);
        state.arrayOfPlayers = new ArraySchema(new Player("arr1", 1, 1), new Player("arr2", 2, 2));
        state.mapOfPlayers = new MapSchema<Player>({
            'one': new Player("One", 1, 1),
            'two': new Player("Two", 2, 2),
        });
    });

    it("should be compatible with JSON.stringify", () => {
        assert.strictEqual(JSON.stringify(state), JSON.stringify(targetState));
    });

    it("should be compatible with msgpack.encode", () => {
        assert.deepEqual(pack(state), pack(targetState));
    });

    it("should allow only one child as Schema instance", () => {
        state.player.x = 500;
        const data = {
            number: 10,
            player: state.player
        }
        pack([data]);
    });
})
