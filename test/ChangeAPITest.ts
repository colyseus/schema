import * as sinon from "sinon";
import * as assert from "assert";

import { DataChange, Schema, type } from './../src/annotations';
import { State, Player } from "./Schema";
import { MapSchema, ArraySchema } from "../src";

describe("Change API", () => {

    describe("Primitive types", () => {
        it("should trigger onChange with a single value", () => {
            const state = new State();
            state.fieldNumber = 50;

            const decodedState = new State();
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "fieldNumber");
                assert.equal(changes[0].value, 50);
                assert.equal(changes[0].previousValue, undefined);
            }

            const onChangeSpy = sinon.spy(decodedState, 'onChange');

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
        });

        it("should trigger onChange with multiple values", () => {
            const state = new State();
            state.fieldNumber = 50;
            state.fieldString = "Hello world!";

            const decodedState = new State();
            decodedState.onChange = function (changes: DataChange[]) {
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

            decodedState.onChange = function (changes: DataChange[]) {
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
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "player");
            }
            let onChangeSpy = sinon.spy(decodedState, 'onChange');

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.player.name = "Snake";

            decodedState.player.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "name");
                assert.equal(changes[0].value, "Snake");
                assert.equal(changes[0].previousValue, "Jake");
            }
            playerSpy = sinon.spy(decodedState.player, 'onChange');

            // overwrite `onChange` for second decode
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
            }
            onChangeSpy = sinon.spy(decodedState, 'onChange');

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
            sinon.assert.calledOnce(playerSpy);
        });

        it("should trigger onChange when removing child object", () => {
            const state = new State();
            state.player = new Player("Jake", 10, 10);

            const decodedState = new State();
            decodedState.decode(state.encode());

            decodedState.onChange = function (changes: DataChange[]) {
                console.log(changes);
                // assert.equal(changes.length, 1);
                // assert.equal(changes[0].field, "player");
            }
            let onChangeSpy = sinon.spy(decodedState, 'onChange');

            state.player = null;
            decodedState.decode(state.encode());

            sinon.assert.calledOnce(onChangeSpy);
        });
    });

    describe("ArraySchema", () => {
        it("detecting onChange on arrays", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema(new Player("Jake Badlands"), new Player("Katarina Lyons"));

            const decodedState = new State();
            decodedState.arrayOfPlayers = new ArraySchema();
            decodedState.arrayOfPlayers.onAdd = function (player: Player) { }
            const onAddPlayerSpy = sinon.spy(decodedState.arrayOfPlayers, 'onAdd');

            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "arrayOfPlayers");
                assert.equal(changes[0].value.length, 2);

                assert.equal(changes[0].value[0].name, "Jake Badlands");
                assert.equal(changes[0].value[1].name, "Katarina Lyons");
            }

            let onChangeSpy = sinon.spy(decodedState, 'onChange');


            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.arrayOfPlayers.push(new Player("Snake Sanders"));
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "arrayOfPlayers");
                assert.equal(changes[0].value.length, 1);

                assert.equal(changes[0].value[0].name, "Snake Sanders");
            }

            onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            sinon.assert.calledThrice(onAddPlayerSpy);
        });

        it("detecting onChange on array holder", () => {
            class MyState extends Schema {
                @type(["number"])
                arrayOfNumbers: ArraySchema<number> = new ArraySchema();
            }

            const state = new MyState();
            state.arrayOfNumbers = new ArraySchema(10, 20, 30, 40, 50, 60, 70);

            const decodedState = new MyState();
            decodedState.arrayOfNumbers.onChange = function(item, index) {}
            const onChangeSpy = sinon.spy(decodedState.arrayOfNumbers, 'onChange');

            decodedState.decode(state.encode());
            assert.deepEqual(decodedState.arrayOfNumbers, [10, 20, 30, 40, 50, 60, 70]);

            // mutate array
            state.arrayOfNumbers[0] = 0;
            state.arrayOfNumbers[3] = 10;
            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfNumbers, [0, 20, 30, 10, 50, 60, 70]);

            // mutate array
            state.arrayOfNumbers[4] = 40;
            state.arrayOfNumbers[6] = 100;
            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfNumbers, [0, 20, 30, 10, 40, 60, 100]);
            sinon.assert.callCount(onChangeSpy, 11);
        });

        it("detecting onRemove on array items", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema(new Player("Jake Badlands"), new Player("Katarina Lyons"));

            let katarina: Player;

            const decodedState = new State();
            decodedState.onChange = function (changes: DataChange[]) {
                katarina = changes[0].value[1];
                assert.ok(katarina instanceof Player);
            };

            let onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.arrayOfPlayers.splice(1);

            katarina.onRemove = function () { }
            const onItemRemoveSpy = sinon.spy(katarina, "onRemove");

            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
            }

            onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
            sinon.assert.calledOnce(onItemRemoveSpy);
        });
    });

    describe("MapSchema", () => {
        it("detecting onChange on maps", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands"),
                'katarina': new Player("Katarina Lyons"),
            });

            const decodedState = new State();
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "mapOfPlayers");
                assert.equal(Object.keys(changes[0].value).length, 2);

                assert.equal(changes[0].value.jake.name, "Jake Badlands");
                assert.equal(changes[0].value.katarina.name, "Katarina Lyons");
            }

            let onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.mapOfPlayers['snake'] = new Player("Snake Sanders");
            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
                assert.equal(changes[0].field, "mapOfPlayers");
                assert.equal(Object.keys(changes[0].value).length, 3);

                assert.equal(changes[0].value.snake.name, "Snake Sanders");
            }

            onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
        });

        it("detecting multiple changes on item inside a map", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands")
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            decodedState.mapOfPlayers['jake'].onChange = function (changes: DataChange[]) { }
            let onChangeSpy = sinon.spy(decodedState.mapOfPlayers['jake'], 'onChange');

            state.mapOfPlayers['jake'].x = 100;
            let encoded = state.encode();
            decodedState.decode(encoded);

            state.mapOfPlayers['jake'].x = 200;
            encoded = state.encode();
            decodedState.decode(encoded);

            sinon.assert.calledTwice(onChangeSpy);
        });

        it("should call onAdd / onRemove on map", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands"),
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            decodedState.mapOfPlayers.onAdd = function (player: Player, key: string) {
                assert.ok(key);
            }
            decodedState.mapOfPlayers.onRemove = function (player: Player, key: string) {
                assert.ok(key);
            }

            // add two entries
            state.mapOfPlayers['snake'] = new Player("Snake Sanders");
            state.mapOfPlayers['katarina'] = new Player("Katarina Lyons");

            const onAddSpy = sinon.spy(decodedState.mapOfPlayers, 'onAdd');
            const onRemoveSpy = sinon.spy(decodedState.mapOfPlayers, 'onRemove');

            let encoded = state.encode();
            decodedState.decode(encoded);

            // remove one entry
            delete state.mapOfPlayers['snake'];
            encoded = state.encode();
            decodedState.decode(encoded);

            sinon.assert.calledTwice(onAddSpy);
            sinon.assert.calledOnce(onRemoveSpy);
        });

        it("should not loose reference when add / remove is performed at once", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                ['food1']: new Player("food 1", 1, 1),
                ['food2']: new Player("food 2", 2, 2),
                ['food3']: new Player("food 3", 3, 3),
                ['food4']: new Player("food 4", 4, 4),
                ['food5']: new Player("food 5", 5, 5),
                ['food6']: new Player("food 6", 6, 6),
                ['food7']: new Player("food 7", 7, 7),
                ['food8']: new Player("food 8", 8, 8),
                ['food9']: new Player("food 9", 9, 9),
                'player': new Player("Player", 10, 10)
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            /* CHANGESET */
            let keyAddition = 'food10';
            let keyRemoval = 'food2';
            decodedState.mapOfPlayers.onAdd = (player: Player, key: string) => { assert.equal(key, keyAddition); }
            decodedState.mapOfPlayers.onRemove = (player: Player, key: string) => { assert.equal(key, keyRemoval); }
            decodedState.mapOfPlayers.onChange = (player: Player, key: string) => { assert.equal(key, 'player'); }

            const unchangedSpies = ['food1', 'food2', 'food3', 'food4', 'food5', 'food6', 'food7', 'food8', 'food9'].map((key) => {
                decodedState.mapOfPlayers[key].onChange = function () {};
                return sinon.spy(decodedState.mapOfPlayers[key], 'onChange');
            });

            // move "player", delete one food, insert another.
            state.mapOfPlayers['player'].x += 1;
            state.mapOfPlayers['player'].y += 1;
            state.mapOfPlayers[keyAddition] = new Player("food 10", 10, 10);
            delete state.mapOfPlayers[keyRemoval];

            decodedState.decode(state.encode());

            assert.equal(decodedState.mapOfPlayers['food1'].x, 1);
            assert.equal(decodedState.mapOfPlayers['food2'], undefined);
            assert.equal(decodedState.mapOfPlayers['food3'].x, 3);
            assert.equal(decodedState.mapOfPlayers['food4'].x, 4);
            assert.equal(decodedState.mapOfPlayers['food5'].x, 5);
            assert.equal(decodedState.mapOfPlayers['food6'].x, 6);
            assert.equal(decodedState.mapOfPlayers['food7'].x, 7);
            assert.equal(decodedState.mapOfPlayers['food8'].x, 8);
            assert.equal(decodedState.mapOfPlayers['food9'].x, 9);
            assert.equal(decodedState.mapOfPlayers['food10'].x, 10);
            assert.equal(decodedState.mapOfPlayers['player'].x, 11);

            /* 
             * CHANGESET
             */
            state.mapOfPlayers['player'].x += 1;
            state.mapOfPlayers['player'].y += 1;
            decodedState.decode(state.encode());

            assert.equal(decodedState.mapOfPlayers['food1'].x, 1);
            assert.equal(decodedState.mapOfPlayers['food2'], undefined);
            assert.equal(decodedState.mapOfPlayers['food3'].x, 3);
            assert.equal(decodedState.mapOfPlayers['food4'].x, 4);
            assert.equal(decodedState.mapOfPlayers['food5'].x, 5);
            assert.equal(decodedState.mapOfPlayers['food6'].x, 6);
            assert.equal(decodedState.mapOfPlayers['food7'].x, 7);
            assert.equal(decodedState.mapOfPlayers['food8'].x, 8);
            assert.equal(decodedState.mapOfPlayers['food9'].x, 9);
            assert.equal(decodedState.mapOfPlayers['food10'].x, 10);
            assert.equal(decodedState.mapOfPlayers['player'].x, 12);

            /* 
             * CHANGESET
             */
            keyAddition = 'food11';
            keyRemoval = 'food5';

            // move "player", delete one food, insert another.
            state.mapOfPlayers['player'].x += 1;
            state.mapOfPlayers['player'].y += 1;
            state.mapOfPlayers[keyAddition] = new Player("food 11", 11, 11);
            delete state.mapOfPlayers[keyRemoval];

            decodedState.decode(state.encode());

            assert.equal(decodedState.mapOfPlayers['food1'].x, 1);
            assert.equal(decodedState.mapOfPlayers['food2'], undefined);
            assert.equal(decodedState.mapOfPlayers['food3'].x, 3);
            assert.equal(decodedState.mapOfPlayers['food4'].x, 4);
            assert.equal(decodedState.mapOfPlayers['food5'], undefined);
            assert.equal(decodedState.mapOfPlayers['food6'].x, 6);
            assert.equal(decodedState.mapOfPlayers['food7'].x, 7);
            assert.equal(decodedState.mapOfPlayers['food8'].x, 8);
            assert.equal(decodedState.mapOfPlayers['food9'].x, 9);
            assert.equal(decodedState.mapOfPlayers['food10'].x, 10);
            assert.equal(decodedState.mapOfPlayers['food11'].x, 11);
            assert.equal(decodedState.mapOfPlayers['player'].x, 13);

            /* 
             * CHANGESET
             */

            state.mapOfPlayers['player'].x += 1;
            state.mapOfPlayers['player'].y += 1;

            decodedState.decode(state.encode());

            assert.equal(decodedState.mapOfPlayers['food1'].x, 1);
            assert.equal(decodedState.mapOfPlayers['food2'], undefined);
            assert.equal(decodedState.mapOfPlayers['food3'].x, 3);
            assert.equal(decodedState.mapOfPlayers['food4'].x, 4);
            assert.equal(decodedState.mapOfPlayers['food5'], undefined);
            assert.equal(decodedState.mapOfPlayers['food6'].x, 6);
            assert.equal(decodedState.mapOfPlayers['food7'].x, 7);
            assert.equal(decodedState.mapOfPlayers['food8'].x, 8);
            assert.equal(decodedState.mapOfPlayers['food9'].x, 9);
            assert.equal(decodedState.mapOfPlayers['food10'].x, 10);
            assert.equal(decodedState.mapOfPlayers['food11'].x, 11);
            assert.equal(decodedState.mapOfPlayers['player'].x, 14);

            /* 
             * ADDS SECOND DECODER 
             */
            const secondDecodedState = new State();
            secondDecodedState.decode(state.encodeAll());

            assert.equal(JSON.stringify(secondDecodedState), JSON.stringify(decodedState));

            // "food"'s onChange should NOT be called.
            unchangedSpies.forEach((onChangedSpy) => sinon.assert.notCalled(onChangedSpy));
        });

        it("should call onAdd 5 times", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake")
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            decodedState.mapOfPlayers.onAdd = function (player: Player, key: string) {
                assert.ok(key);
            }
            const onAddSpy = sinon.spy(decodedState.mapOfPlayers, 'onAdd');

            delete state.mapOfPlayers['jake'];
            for (let i = 0; i < 5; i++) {
                state.mapOfPlayers[i] = new Player("Player " + i, Math.random() * 2000, Math.random() * 2000);
            }

            let encoded = state.encode();
            decodedState.decode(encoded);

            assert.equal(Object.keys(decodedState.mapOfPlayers).length, 5);
            sinon.assert.callCount(onAddSpy, 5);
        });

        it("detecting onRemove on map items", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands"),
                'katarina': new Player("Katarina Lyons"),
            });

            let katarina: Player;

            const decodedState = new State();
            decodedState.onChange = function (changes: DataChange[]) {
                katarina = changes[0].value.katarina;
                assert.ok(katarina instanceof Player);
            }

            let onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            delete state.mapOfPlayers['katarina'];
            katarina.onRemove = function () { }
            const onItemRemoveSpy = sinon.spy(katarina, "onRemove");

            decodedState.onChange = function (changes: DataChange[]) {
                assert.equal(changes.length, 1);
            }

            onChangeSpy = sinon.spy(decodedState, 'onChange');
            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
            sinon.assert.calledOnce(onItemRemoveSpy);
        });
    });

    describe("encodeAll", () => {
        it("shouldn't trigger onRemove for previously removed items", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>({
                'player': new Player("Player One", 0, 0)
            });
            state.encode();

            delete state.mapOfPlayers['player'];
            state.encode();

            const decodedState = new State();
            decodedState.mapOfPlayers = new MapSchema<Player>();
            decodedState.mapOfPlayers.onRemove = function() {}
            const onRemoveSpy = sinon.spy(decodedState.mapOfPlayers, 'onRemove');

            decodedState.decode(state.encodeAll());

            sinon.assert.notCalled(onRemoveSpy);
        });
    });

});