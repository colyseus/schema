import * as sinon from "sinon";
import * as assert from "assert";

import { DataChange } from './../src/annotations';
import { State, Player } from "./Schema";

describe("Change API", () => {

    it("should trigger onChange with a single value", () => {
        const state = new State();
        state.fieldNumber = 50;

        const decodedState = new State();
        decodedState.onChange = function(changes: DataChange[]) {
            assert.equal(changes.length, 1);
            assert.equal(changes[0].field, "fieldNumber");
            assert.equal(changes[0].value, 50);
            assert.equal(changes[0].previousValue, undefined);
        }

        const onChangeSpy = sinon.spy(decodedState, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onChangeSpy);
    })

    it("should trigger onChange with multiple values", () => {
        const state = new State();
        state.fieldNumber = 50;
        state.fieldString = "Hello world!";

        const decodedState = new State();
        decodedState.onChange = function(changes: DataChange[]) {
            assert.equal(changes.length, 2);
            assert.equal(changes[0].field, "fieldNumber");
            assert.equal(changes[0].value, 50);
            assert.equal(changes[0].previousValue, undefined);

            assert.equal(changes[1].field, "fieldString");
            assert.equal(changes[1].value, "Hello world!");
            assert.equal(changes[1].previousValue, undefined);
        }
        let onChangeSpy = sinon.spy(decodedState, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onChangeSpy);

        state.fieldNumber = 100;
        state.fieldString = "Again";

        decodedState.onChange = function(changes: DataChange[]) {
            assert.equal(changes.length, 2);
            assert.equal(changes[0].field, "fieldNumber");
            assert.equal(changes[0].value, 100);
            assert.equal(changes[0].previousValue, 50);

            assert.equal(changes[1].field, "fieldString");
            assert.equal(changes[1].value, "Again");
            assert.equal(changes[1].previousValue, "Hello world!");
        }
        onChangeSpy = sinon.spy(decodedState, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onChangeSpy);
    });

    it("should trigger onChange on child objects", () => {
        const state = new State();
        state.player = new Player("Jake", 10, 10);

        let playerSpy: sinon.SinonSpy;

        const decodedState = new State();
        decodedState.onChange = function(changes: DataChange[]) {
            assert.equal(changes.length, 1);
            assert.equal(changes[0].field, "player");

            if (!changes[0].previousValue) {
                const player = changes[0].value as Player;
                player.onChange = function(changes: DataChange[]) {
                    assert.equal(changes.length, 1);
                    assert.equal(changes[0].field, "name");
                    assert.equal(changes[0].value, "Snake");
                    assert.equal(changes[0].previousValue, "Jake");
                }

                playerSpy = sinon.spy(player, 'onChange');
            }
        }
        let onChangeSpy = sinon.spy(decodedState, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onChangeSpy);

        state.player.name = "Snake";

        // overwrite `onChange` for second decode
        decodedState.onChange = function(changes: DataChange[]) {
            assert.equal(changes.length, 1);
        }
        onChangeSpy = sinon.spy(decodedState, 'onChange');

        decodedState.decode(state.encode());
        sinon.assert.calledOnce(onChangeSpy);
        sinon.assert.calledOnce(playerSpy);
    });

});