import * as sinon from "sinon";

import { State, Player } from "./Schema";
import { ArraySchema } from "../src";

describe("ArraySchema", () => {

    it("should allow .sort()", () => {
        const state = new State();
        state.arrayOfPlayers = new ArraySchema<Player>();
        state.arrayOfPlayers.push(new Player("One", 10));
        state.arrayOfPlayers.push(new Player("Two", 30));
        state.arrayOfPlayers.push(new Player("Three", 20));
        state.arrayOfPlayers.push(new Player("Four", 50));
        state.arrayOfPlayers.push(new Player("Five", 40));

        const decodedState = new State();
        decodedState.arrayOfPlayers = new ArraySchema<Player>();

        decodedState.arrayOfPlayers.onAdd = function(item, i) {};
        const onAddSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

        decodedState.arrayOfPlayers.onChange = function(item, i) {};
        const onChangeSpy = sinon.spy(decodedState.arrayOfPlayers, 'onChange');

        decodedState.decode(state.encodeAll());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 0);

        state.arrayOfPlayers.sort((a, b) => 1);
        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 5);

        state.arrayOfPlayers.sort((a, b) => b.x - a.x);
        console.log(JSON.stringify(state.arrayOfPlayers));
        decodedState.decode(state.encode());
        sinon.assert.callCount(onAddSpy, 5);
        sinon.assert.callCount(onChangeSpy, 10);

        for (var a = 0; a < 100; a++)
        {
            for (var b = 0; b < state.arrayOfPlayers.length; b++)
            {
                var player = state.arrayOfPlayers[b];

                player.x = Math.floor (Math.random () * 100000);
            }

            state.arrayOfPlayers.sort((a, b) => b.x - a.x);
            console.log(JSON.stringify(state.arrayOfPlayers));
            decodedState.decode(state.encode());
            sinon.assert.callCount(onAddSpy, 5);
            sinon.assert.callCount(onChangeSpy, 15);
        }
    });

});
