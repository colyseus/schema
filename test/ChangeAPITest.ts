import * as sinon from "sinon";
import * as util from "util";
import * as assert from "assert";

import { State, Player } from "./Schema";
import { Schema, MapSchema, ArraySchema, DataChange, Reflection, type, filter, Context } from "../src";

describe("Change API", () => {

    describe("Primitive types", () => {
        it("should trigger onChange with a single value", () => {
            const state = new State();
            state.fieldNumber = 50;

            const decodedState = new State();

            const onStateChange = sinon.spy(() => {});
            decodedState.onChange(onStateChange);

            // decodedState.onChange(function (changes: DataChange[]) {
            //     assert.strictEqual(changes.length, 1);
            //     assert.strictEqual(changes[0].field, "fieldNumber");
            //     assert.strictEqual(changes[0].value, 50);
            //     assert.strictEqual(changes[0].previousValue, undefined);
            // });

            const fieldNumberChange = (value, previousValue) => assert.ok(value === 50);
            const onFieldNumberChangeSpy = sinon.spy(fieldNumberChange);
            decodedState.listen("fieldNumber", onFieldNumberChangeSpy);

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onStateChange);
            sinon.assert.calledOnce(onFieldNumberChangeSpy);
        });

        xit("should trigger onChange with multiple values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;

            const decodedState = new State();
            // decodedState.onChange = function (changes: DataChange[]) {
            //     assert.strictEqual(changes.length, 2);

            //     assert.strictEqual(changes[0].field, "fieldString");
            //     assert.strictEqual(changes[0].value, "Hello world!");
            //     assert.strictEqual(changes[0].previousValue, undefined);

            //     assert.strictEqual(changes[1].field, "fieldNumber");
            //     assert.strictEqual(changes[1].value, 50);
            //     assert.strictEqual(changes[1].previousValue, undefined);
            // }
            let onChangeSpy = sinon.spy(decodedState, 'onChange');

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.fieldNumber = 100;
            state.fieldString = "Again";

            // decodedState.onChange = function (changes: DataChange[]) {
            //     assert.strictEqual(changes.length, 2);

            //     assert.strictEqual(changes[0].field, "fieldNumber");
            //     assert.strictEqual(changes[0].value, 100);
            //     assert.strictEqual(changes[0].previousValue, 50);

            //     assert.strictEqual(changes[1].field, "fieldString");
            //     assert.strictEqual(changes[1].value, "Again");
            //     assert.strictEqual(changes[1].previousValue, "Hello world!");
            // }
            onChangeSpy = sinon.spy(decodedState, 'onChange');

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);
        });

        it("should trigger onChange on child objects", () => {
            const state = new State();
            state.player = new Player("Jake", 10, 10);

            let playerSpy: sinon.SinonSpy;
            let rootOnChangeCallCount = 0;
            let playerOnChangeCallCount = 0;

            const decodedState = new State();
            const unbindRootOnChange = decodedState.onChange(() => rootOnChangeCallCount++);

            decodedState.decode(state.encode());
            state.player.name = "Snake";

            playerSpy = sinon.spy(() => playerOnChangeCallCount ++);
            decodedState.player.onChange(playerSpy);

            // remove previous root onChange
            unbindRootOnChange();
            rootOnChangeCallCount = 0;

            decodedState.decode(state.encode());
            assert.strictEqual(0, rootOnChangeCallCount);
            sinon.assert.calledOnce(playerSpy);
        });

        it("should trigger onChange and onRemove when removing child object", () => {
            const state = new State();
            state.player = new Player("Jake", 10, 10);

            const decodedState = new State();
            decodedState.decode(state.encode());

            let onChangeCalledCount = 0;
            let onRemoveCalledCount = 0;

            const onChangeSpy = sinon.spy(() => onChangeCalledCount++);
            decodedState.onChange(onChangeSpy);

            const onRemoveSpy = sinon.spy(() => onRemoveCalledCount++);
            decodedState.player.onRemove(onRemoveSpy);

            state.player = null;
            decodedState.decode(state.encode());

            sinon.assert.calledOnce(onChangeSpy);
            sinon.assert.calledOnce(onRemoveSpy);
        });
    });

    describe("Re-assignments", () => {
        it("should not trigger change if value is changed back and forth to same value", () => {
            class State extends Schema {
                @type("boolean") bool: boolean;
            }

            const state = new State();
            state.bool = false;

            const decodedState = new State();

            let changeCallCount: number = 0;
            decodedState.listen("bool", (value) => changeCallCount++);

            decodedState.decode(state.encode());

            state.bool = true;
            state.bool = false;

            decodedState.decode(state.encode());

            assert.strictEqual(1, changeCallCount);
        })

        // FIXME: dealing with schema callbacks on confusing instance replacement
        // https://github.com/colyseus/colyseus-unity3d/issues/169
        xit("should allow to remove onChange reference from child structure", () => {
            class Phase extends Schema {
                @type('int32') value: number = 1;
            }

            class GameState extends Schema {
                @type(Phase) readonly phase: Phase = new Phase();
            }

            const state = new GameState();

            let phaseOnChangeCalls = 0;
            const decodedState = new GameState();
            const phase = decodedState.phase;
            phase.onChange(() => phaseOnChangeCalls++);
            decodedState.decode(state.encode());
            // decodedState.triggerAll();

            state.phase.value++;
            decodedState.decode(state.encode());

            state.phase.value++;
            phase.onChange = undefined;
            decodedState.decode(state.encode());

            assert.strictEqual(2, phaseOnChangeCalls);
        });
    });

    describe("ArraySchema", () => {
        it("should trigger onAdd only once for inner structures", () => {
            class Restaurant extends Schema {
                @type([ "number" ]) objects: ArraySchema<number> = new ArraySchema<number>();
            }
            class MyRoomState extends Schema {
                @type({ map: Restaurant }) restaurants = new MapSchema<Restaurant>();
            }

            const remoteState = new MyRoomState();
            const restaurant = new Restaurant();
            remoteState.restaurants.set("one", restaurant);
            restaurant.objects.push(100);

            const state = new MyRoomState();

            let onAddCallCount = 0;
            state.restaurants.onAdd((restaurant, restaurantKey) => {
                restaurant.objects.onAdd(async (gameObject, objectKey) => {
                    onAddCallCount++;
                })
            });
            state.decode(remoteState.encode());

            assert.strictEqual(1, onAddCallCount);
        });

        it("detecting onChange on arrays", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema(new Player("Jake Badlands"), new Player("Katarina Lyons"));

            const decodedState = new State();
            decodedState.arrayOfPlayers = new ArraySchema();

            let callCount: number = 0;

            const onAddPlayerSpy = sinon.spy((item: Player, key: number) => {
                if (callCount === 0) {
                    assert.strictEqual(item.name, "Jake Badlands");
                    assert.strictEqual(0, key);

                } else if (callCount === 1) {
                    assert.strictEqual(item.name, "Katarina Lyons");
                    assert.strictEqual(1, key);

                } else if (callCount === 2) {
                    assert.strictEqual(item.name, "Snake Sanders");
                    assert.strictEqual(2, key);
                }

                callCount++;
            });
            decodedState.arrayOfPlayers.onAdd(onAddPlayerSpy);

            const onChange = sinon.spy(() => {});
            decodedState.onChange(onChange);

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChange);

            state.arrayOfPlayers.push(new Player("Snake Sanders"));

            decodedState.decode(state.encode());
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

            const onRemoveSpy = sinon.spy((item, index) => {});
            decodedState.arrayOfNumbers.onRemove(onRemoveSpy);

            const onAddSpy = sinon.spy((item, index) => {});
            decodedState.arrayOfNumbers.onAdd(onAddSpy);

            const onChangeSpy = sinon.spy((item, index) => {});
            decodedState.arrayOfNumbers.onChange(onChangeSpy);

            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfNumbers.toArray(), [10, 20, 30, 40, 50, 60, 70]);
            sinon.assert.callCount(onAddSpy, 7);

            // mutate array
            state.arrayOfNumbers[0] = 0;
            state.arrayOfNumbers[3] = 10;
            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfNumbers.toArray(), [0, 20, 30, 10, 50, 60, 70]);
            sinon.assert.callCount(onChangeSpy, 9);

            // mutate array
            state.arrayOfNumbers[4] = 40;
            state.arrayOfNumbers[6] = 100;
            decodedState.decode(state.encode());

            assert.deepEqual(decodedState.arrayOfNumbers.toArray(), [0, 20, 30, 10, 40, 60, 100]);
            sinon.assert.callCount(onAddSpy, 7);
            sinon.assert.callCount(onChangeSpy, 11);
            sinon.assert.notCalled(onRemoveSpy);
        });

        it("detecting onRemove on array items", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema(new Player("Jake Badlands"), new Player("Katarina Lyons"));

            let jake: Player;

            const decodedState = new State();

            const onChangeSpy1 = sinon.spy(() => {
                jake = decodedState.arrayOfPlayers[0];
            });
            decodedState.onChange(onChangeSpy1);

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy1);

            state.arrayOfPlayers.shift();

            const onArrayItemRemove = sinon.spy((item, index) => assert.strictEqual(item.name, jake.name));
            decodedState.arrayOfPlayers.onRemove(onArrayItemRemove);

            const onItemRemoveSpy = sinon.spy(() => {});
            jake.onRemove(onItemRemoveSpy);

            const onChangeSpy2 = sinon.spy(() => {});
            decodedState.onChange(onChangeSpy2);

            decodedState.decode(state.encode());

            sinon.assert.calledOnce(onItemRemoveSpy);
            sinon.assert.calledOnce(onArrayItemRemove);
        });

        it("should call onAdd / onChance correctly for 0's", () => {
            class GridState extends Schema {
                @type(["number"]) grid: ArraySchema<number>;
            }

            const state = new GridState();
            state.grid = new ArraySchema(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

            const decodedState = new GridState();

            decodedState.grid = new ArraySchema<number>();

            const onAdd = sinon.spy((item, index) => {});
            const onChange = sinon.spy((item, index) => {});
            decodedState.grid.onAdd(onAdd);
            decodedState.grid.onChange(onChange);

            decodedState.decode(state.encode());

            state.grid[0] = 1;
            decodedState.decode(state.encode());

            state.grid[2] = 1;
            decodedState.decode(state.encode());

            state.grid[5] = 1;
            decodedState.decode(state.encode());

            state.grid[5] = 0;
            decodedState.decode(state.encode());

            sinon.assert.callCount(onAdd, 12);
            sinon.assert.callCount(onChange, 16);
        });

        it("should call onAdd when replacing items", () => {
            const type = Context.create();

            class Card extends Schema {
                @type("number") num: number;
            }

            class Player extends Schema {
                @type([Card]) cards = new ArraySchema<Card>();
            }

            class CardGameState extends Schema {
                @type(Player) player = new Player();
            }

            const state = new CardGameState();
            state.player.cards.push(new Card().assign({ num: 1 }));

            const decodedState = Reflection.decode<CardGameState>(Reflection.encode(state));

            let onAdd: sinon.SinonSpy;
            decodedState.player.onChange(() => {
                onAdd = sinon.spy((item, index) => {});
                decodedState.player.cards.onAdd(onAdd, false);
            });

            decodedState.decode(state.encode());
            sinon.assert.callCount(onAdd, 1);

            state.player.cards.splice(0, 1);
            state.player.cards.push(new Card().assign({ num: 2 }));
            decodedState.decode(state.encode());
            sinon.assert.callCount(onAdd, 2);
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

            const onChange = sinon.spy(() => {});
            decodedState.onChange(onChange);
            // {
            //     assert.strictEqual(changes.length, 1);
            //     assert.strictEqual(changes[0].field, "mapOfPlayers");
            //     assert.strictEqual(Object.keys(changes[0].value).length, 2);

            //     assert.strictEqual(changes[0].value.jake.name, "Jake Badlands");
            //     assert.strictEqual(changes[0].value.katarina.name, "Katarina Lyons");
            // }

            decodedState.mapOfPlayers = new MapSchema();

            let callCount: number = 0;
            const onAdd = sinon.spy((item, key) => {
                if (callCount === 0) {
                    assert.strictEqual("jake", key);
                    assert.strictEqual("Jake Badlands", item.name);

                } else if (callCount === 1) {
                    assert.strictEqual("katarina", key);
                    assert.strictEqual("Katarina Lyons", item.name);

                } else if (callCount === 3) {
                    assert.strictEqual("snake", key);
                    assert.strictEqual("Snake Sanders", item.name);
                }
                callCount++;
            });
            decodedState.mapOfPlayers.onAdd(onAdd);

            const onRemove = sinon.spy((item, key) => {});
            decodedState.mapOfPlayers.onRemove(onRemove);

            decodedState.decode(state.encode());

            sinon.assert.callCount(onAdd, 2);
            sinon.assert.calledOnce(onChange);

            state.mapOfPlayers.set('snake', new Player("Snake Sanders"));

            decodedState.decode(state.encode());
            sinon.assert.callCount(onChange, 1);
            sinon.assert.callCount(onAdd, 3);
            sinon.assert.callCount(onRemove, 0);
        });

        it("detecting onChange on map of primitive values", () => {
            class State extends Schema {
                @type({ map: "number" }) numbers = new MapSchema<number>();
            }

            const state = new State();
            state.numbers.set('one', 1);
            state.numbers.set('two', 2);

            const decodedState = new State();

            const onAdd = sinon.spy((item, key) => {});
            decodedState.numbers.onAdd(onAdd)

            const onChange = sinon.spy(function(item, key) {});
            decodedState.numbers.onChange(onChange);

            const onRemove = sinon.spy(function(item, key) {});
            decodedState.numbers.onRemove(onRemove);
            decodedState.decode(state.encode());

            state.numbers.set('one', 11);
            state.numbers.set('two', 22);
            state.numbers.set('three', 3);

            decodedState.decode(state.encode());

            sinon.assert.callCount(onAdd, 3);
            sinon.assert.callCount(onChange, 5);

            state.numbers.delete('one');
            state.numbers.set('three', 33);

            decodedState.decode(state.encode());
            sinon.assert.callCount(onChange, 7);
            sinon.assert.callCount(onAdd, 3);
            sinon.assert.callCount(onRemove, 1);
        });

        it("detecting multiple changes on item inside a map", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands")
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            const onChange = sinon.spy(function () {});
            decodedState.mapOfPlayers.get('jake').onChange(onChange);

            state.mapOfPlayers['jake'].x = 100;
            let encoded = state.encode();
            decodedState.decode(encoded);

            state.mapOfPlayers['jake'].x = 200;
            encoded = state.encode();
            decodedState.decode(encoded);

            sinon.assert.calledTwice(onChange);
        });

        it("should call onAdd / onRemove on map", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                'jake': new Player("Jake Badlands"),
            });

            const decodedState = new State();
            decodedState.decode(state.encode());

            let addCallCount: number = 0;

            const onAddSpy = sinon.spy(function (player: Player, key: string) {
                if (addCallCount === 0) {
                    assert.strictEqual("jake", key);

                } else if (addCallCount === 1) {
                    assert.strictEqual("snake", key);

                } else if (addCallCount === 2) {
                    assert.strictEqual("katarina", key);
                }
                addCallCount++;
            });
            const onRemoveSpy = sinon.spy(function (player: Player, key: string) {
                assert.strictEqual("snake", key);
            });

            decodedState.mapOfPlayers.onAdd(onAddSpy);
            decodedState.mapOfPlayers.onRemove(onRemoveSpy);

            // add two entries
            state.mapOfPlayers.set('snake', new Player("Snake Sanders"));
            state.mapOfPlayers.set('katarina', new Player("Katarina Lyons"));

            let encoded = state.encode();
            decodedState.decode(encoded);

            // remove one entry
            state.mapOfPlayers.delete('snake');

            encoded = state.encode();
            decodedState.decode(encoded);

            sinon.assert.calledThrice(onAddSpy);
            sinon.assert.calledOnce(onRemoveSpy);
        });

        it("should allow onAdd using primitive types", () => {
            class MapWithPrimitive extends Schema {
                @type({map: "boolean"}) mapOfBool = new MapSchema<boolean>();
            }

            const state = new MapWithPrimitive();
            state.mapOfBool['one'] = true;

            const decodedState = new MapWithPrimitive();
            const onAddSpy = sinon.spy(function(value, key) { console.log("ON ADD", value, key); });
            decodedState.mapOfBool.onAdd(onAddSpy)

            decodedState.decode(state.encodeAll());

            state.mapOfBool['two'] = true;

            decodedState.decode(state.encode());

            sinon.assert.calledTwice(onAddSpy);
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

            decodedState.mapOfPlayers.onAdd((player: Player, key: string) => {
                assert.strictEqual(key, keyAddition);
            }, false);
            decodedState.mapOfPlayers.onRemove((player: Player, key: string) => { assert.strictEqual(key, keyRemoval); });
            decodedState.mapOfPlayers.onChange((player: Player, key: string) => {});

            const unchangedSpies = ['food1', 'food2', 'food3', 'food4', 'food5', 'food6', 'food7', 'food8', 'food9'].map((key) => {
                decodedState.mapOfPlayers[key].onChange = function () {};
                return sinon.spy(decodedState.mapOfPlayers[key], 'onChange');
            });

            // move "player", delete one food, insert another.
            state.mapOfPlayers.get('player').x += 1;
            state.mapOfPlayers.get('player').y += 1;
            state.mapOfPlayers.set(keyAddition, new Player("food 10", 10, 10));
            state.mapOfPlayers.delete(keyRemoval);

            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.mapOfPlayers.get('food1').x, 1);
            assert.strictEqual(decodedState.mapOfPlayers.get('food2'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food3').x, 3);
            assert.strictEqual(decodedState.mapOfPlayers.get('food4').x, 4);
            assert.strictEqual(decodedState.mapOfPlayers.get('food5').x, 5);
            assert.strictEqual(decodedState.mapOfPlayers.get('food6').x, 6);
            assert.strictEqual(decodedState.mapOfPlayers.get('food7').x, 7);
            assert.strictEqual(decodedState.mapOfPlayers.get('food8').x, 8);
            assert.strictEqual(decodedState.mapOfPlayers.get('food9').x, 9);
            assert.strictEqual(decodedState.mapOfPlayers.get('food10').x, 10);
            assert.strictEqual(decodedState.mapOfPlayers.get('player').x, 11);

            /*
             * CHANGESET
             */
            state.mapOfPlayers['player'].x += 1;
            state.mapOfPlayers['player'].y += 1;
            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.mapOfPlayers.get('food1').x, 1);
            assert.strictEqual(decodedState.mapOfPlayers.get('food2'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food3').x, 3);
            assert.strictEqual(decodedState.mapOfPlayers.get('food4').x, 4);
            assert.strictEqual(decodedState.mapOfPlayers.get('food5').x, 5);
            assert.strictEqual(decodedState.mapOfPlayers.get('food6').x, 6);
            assert.strictEqual(decodedState.mapOfPlayers.get('food7').x, 7);
            assert.strictEqual(decodedState.mapOfPlayers.get('food8').x, 8);
            assert.strictEqual(decodedState.mapOfPlayers.get('food9').x, 9);
            assert.strictEqual(decodedState.mapOfPlayers.get('food10').x, 10);
            assert.strictEqual(decodedState.mapOfPlayers.get('player').x, 12);

            /*
             * CHANGESET
             */
            keyAddition = 'food11';
            keyRemoval = 'food5';

            // move "player", delete one food, insert another.
            state.mapOfPlayers.get('player').x += 1;
            state.mapOfPlayers.get('player').y += 1;
            state.mapOfPlayers.set(keyAddition, new Player("food 11", 11, 11));
            state.mapOfPlayers.delete(keyRemoval);

            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.mapOfPlayers.get('food1').x, 1);
            assert.strictEqual(decodedState.mapOfPlayers.get('food2'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food3').x, 3);
            assert.strictEqual(decodedState.mapOfPlayers.get('food4').x, 4);
            assert.strictEqual(decodedState.mapOfPlayers.get('food5'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food6').x, 6);
            assert.strictEqual(decodedState.mapOfPlayers.get('food7').x, 7);
            assert.strictEqual(decodedState.mapOfPlayers.get('food8').x, 8);
            assert.strictEqual(decodedState.mapOfPlayers.get('food9').x, 9);
            assert.strictEqual(decodedState.mapOfPlayers.get('food10').x, 10);
            assert.strictEqual(decodedState.mapOfPlayers.get('food11').x, 11);
            assert.strictEqual(decodedState.mapOfPlayers.get('player').x, 13);

            /*
             * CHANGESET
             */

            state.mapOfPlayers.get('player').x += 1;
            state.mapOfPlayers.get('player').y += 1;

            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.mapOfPlayers.get('food1').x, 1);
            assert.strictEqual(decodedState.mapOfPlayers.get('food2'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food3').x, 3);
            assert.strictEqual(decodedState.mapOfPlayers.get('food4').x, 4);
            assert.strictEqual(decodedState.mapOfPlayers.get('food5'), undefined);
            assert.strictEqual(decodedState.mapOfPlayers.get('food6').x, 6);
            assert.strictEqual(decodedState.mapOfPlayers.get('food7').x, 7);
            assert.strictEqual(decodedState.mapOfPlayers.get('food8').x, 8);
            assert.strictEqual(decodedState.mapOfPlayers.get('food9').x, 9);
            assert.strictEqual(decodedState.mapOfPlayers.get('food10').x, 10);
            assert.strictEqual(decodedState.mapOfPlayers.get('food11').x, 11);
            assert.strictEqual(decodedState.mapOfPlayers.get('player').x, 14);

            /*
             * ADDS SECOND DECODER
             */
            const secondDecodedState = new State();
            secondDecodedState.decode(state.encodeAll());

            assert.strictEqual(JSON.stringify(secondDecodedState), JSON.stringify(decodedState));

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

            const onAddSpy = sinon.spy(function (player: Player, key: string) { assert.ok(key); });
            decodedState.mapOfPlayers.onAdd(onAddSpy, false);

            state.mapOfPlayers.delete('jake');
            for (let i = 0; i < 5; i++) {
                state.mapOfPlayers.set(i.toString(), new Player("Player " + i, Math.random() * 2000, Math.random() * 2000));
            }

            let encoded = state.encode();
            decodedState.decode(encoded);

            assert.strictEqual(decodedState.mapOfPlayers.size, 5);
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

            let onChangeSpy = sinon.spy(function () {
                katarina = decodedState.mapOfPlayers.get('katarina');
                assert.ok(katarina instanceof Player);
            });
            decodedState.onChange(onChangeSpy);

            decodedState.decode(state.encode());
            sinon.assert.calledOnce(onChangeSpy);

            state.mapOfPlayers.delete('katarina');
            const onItemRemoveSpy = sinon.spy(() => {});
            katarina.onRemove(onItemRemoveSpy);

            onChangeSpy = sinon.spy(function () {});
            decodedState.onChange(onChangeSpy);

            decodedState.decode(state.encode());
            sinon.assert.notCalled(onChangeSpy);
            sinon.assert.calledOnce(onItemRemoveSpy);
        });

        it(".clear() should call .onRemove for child items", () => {
            //
            // TODO: endel, check here.
            //
            const state = new State();
            state.mapOfPlayers = new MapSchema();
            state.mapOfPlayers.set("one", new Player().assign({ name: "Player 1" }));
            state.mapOfPlayers.set("two", new Player().assign({ name: "Player 2" }));

            const decodedState = new State();

            let onRemoveCalled = 0;
            decodedState.mapOfPlayers = new MapSchema();
            decodedState.mapOfPlayers.onRemove((item, key) => onRemoveCalled++);
            decodedState.decode(state.encode());

            state.mapOfPlayers.clear();
            decodedState.decode(state.encode());

            assert.strictEqual(2, onRemoveCalled, "onRemove should be called once.");
        });
    });

    describe("complex structures", () => {
        it("should identify changes on arrays inside maps", () => {
            class Block extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }
            class Player extends Schema {
                @type([Block]) blocks = new ArraySchema<Block>();
                @type("string") name: string;
            }
            class MyState extends Schema {
                @type({ map: Player })
                players = new MapSchema<Player>();
            }

            const state = new MyState();
            state.players.set('one', new Player().assign({ name: "Jake" }));
            state.players.get('one').blocks.push(new Block().assign({ x: 10, y: 10 }));

            const decodedState = new MyState();
            decodedState.decode(state.encodeAll());

            const onBlockAddSpy = sinon.spy(function (block, key) {});
            decodedState.players.get('one').blocks.onAdd(onBlockAddSpy, false);

            const onBlockChangeSpy = sinon.spy(function (block, key) {});
            decodedState.players.get('one').blocks.onChange(onBlockChangeSpy);

            state.players.get('one').blocks[0].x = 100;
            state.players.get('one').blocks.push(new Block().assign({ x: 50, y: 150 }));
            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.players.get('one').blocks[0].x, 100);
            assert.strictEqual(decodedState.players.get('one').blocks[1].x, 50);
            assert.strictEqual(decodedState.players.get('one').blocks[1].y, 150);

            sinon.assert.calledOnce(onBlockAddSpy);
            sinon.assert.calledOnce(onBlockChangeSpy);
        });

        it("should identify reference inside a reference", () => {
            class Vector3 extends Schema {
                @type("number") x: number;
                @type("number") y: number;
                @type("number") z?: number;
                constructor(x: number = 0, y: number = 0, z?: number) {
                    super();
                    this.x = x;
                    this.y = y;
                    this.z = z;
                }
            }
            class Player extends Schema {
                @type(Vector3) position: Vector3 = new Vector3();
            }
            class MyState extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new MyState();
            const decodedState = new MyState();
            decodedState.decode(state.encodeAll());

            state.players.set('one', new Player());
            decodedState.decode(state.encode());

            state.players.get('one').position.x += 0.01;
            decodedState.decode(state.encode());
            assert.strictEqual(JSON.stringify(decodedState), '{"players":{"one":{"position":{"x":0.01,"y":0}}}}');
        });
    });

    describe("with filters", () => {
        class Round extends Schema {
            @type(["number"]) scores = new ArraySchema<number>(0, 0);
            @type(["number"]) totals = new ArraySchema<number>(0, 0);
        }

        class State extends Schema {
            @filter(() => true)
            @type("number") timer: number;

            @type(Round) currentRound: Round = new Round();
        }

        it("should not trigger unchanged fields", () => {
            let totalsChanges: number = 0;
            let scoresAdded: number = 0;
            let scoresChanges: number = 0;
            let timerChanges: number = 0;

            const state = new State();
            state.timer = 10;

            const client = {};
            const decodedState = new State();
            decodedState.listen("timer", () => timerChanges++);
            decodedState.listen("currentRound", (currentRound) => {
                currentRound.scores.onAdd((value, key) => scoresAdded++, false);
                currentRound.scores.onChange((value, key) => scoresChanges++);
                currentRound.totals.onChange((value, key) => totalsChanges++);
            })

            state.encodeAll(true);
            decodedState.decode(state.applyFilters(client, true));
            state.discardAllChanges();

            do {
                state.timer--;

                state.currentRound.scores[0]++;
                state.currentRound.scores[1]++;

                state.encode(false, undefined, true);
                decodedState.decode(state.applyFilters(client));
                state.discardAllChanges();
            } while (state.timer > 0);

            // set 'totals' field once.
            state.currentRound.totals[0] = 100;
            state.currentRound.totals[1] = 100;

            state.encode(false, undefined, true);
            decodedState.decode(state.applyFilters(client));
            state.discardAllChanges();

            assert.strictEqual(11, timerChanges);
            assert.strictEqual(4, totalsChanges);
            assert.strictEqual(2, scoresAdded);
            assert.strictEqual(22, scoresChanges);
        });
    });

    describe("triggerAll", () => {
        class State extends Schema {
            @type({ map: Player }) mapOfPlayers: MapSchema<Player>;
            @type({ map: "string" }) mapOfStrings: MapSchema<string>;
            @type({ array: "string" }) arrayOfStrings: ArraySchema<string>;
        }

        it("should trigger onChange on Schema instance", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', new Player("Endel", 100, undefined));

            state.mapOfStrings = new MapSchema<string>();
            state.mapOfStrings.set('one', "One");
            state.mapOfStrings.set('two', "Two");

            const decodedState = new State();
            decodedState.mapOfPlayers = new MapSchema<Player>();
            decodedState.decode(state.encode());

            const mapOfStringsOnAdd = sinon.spy(function(item, key) { });
            decodedState.mapOfStrings.onAdd(mapOfStringsOnAdd);

            const player = decodedState.mapOfPlayers.get("one");
            const onChangeSpy = sinon.spy(() => {});
            player.onChange(onChangeSpy);

            sinon.assert.notCalled(onChangeSpy);
            sinon.assert.calledTwice(mapOfStringsOnAdd);
            sinon.assert.calledWith(mapOfStringsOnAdd, "One", "one");
            sinon.assert.calledWith(mapOfStringsOnAdd, "Two", "two");
        });

        it("should recursively trigger onAdd on collections", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', new Player("Jake", 10, 20));
            state.mapOfPlayers.set('two', new Player("Katarina", 30, 40));

            const decodedState = new State();
            decodedState.mapOfPlayers = new MapSchema<Player>();
            decodedState.decode(state.encode());

            let onAddCalled = 0;
            let onChangeCalled = 0;

            decodedState.mapOfPlayers.onAdd(function(player, key) {
                onAddCalled++;
                player.onChange(function() {
                    onChangeCalled++;
                });
            });

            assert.strictEqual(2, onAddCalled, "onAdd should've been called twice.");
            assert.strictEqual(0, onChangeCalled, "onChange should've been called twice.");
        });

        it("collections should implement .triggerAll()", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', new Player("Jake", 10, 20));
            state.mapOfPlayers.set('two', new Player("Katarina", 30, 40));

            const decodedState = new State();
            decodedState.mapOfPlayers = new MapSchema<Player>();
            decodedState.decode(state.encode());

            let onAddCalled = 0;
            let onChangeCalled = 0;

            decodedState.mapOfPlayers.onAdd(function(player, key) {
                onAddCalled++;
                player.onChange(function() {
                    onChangeCalled++;
                    // assert.strictEqual(3, changes.length);
                });
            });
            // decodedState.mapOfPlayers.triggerAll();

            assert.strictEqual(2, onAddCalled, "onAdd should've been called twice.");
            assert.strictEqual(0, onChangeCalled, "onChange shouldn't be called.");
        });

        it("ArraySchema should implement .triggerAll()", () => {
            const state = new State();
            state.arrayOfStrings = new ArraySchema<string>();
            state.arrayOfStrings.push("one");
            state.arrayOfStrings.push("two");

            const decodedState = new State();
            decodedState.arrayOfStrings = new ArraySchema<string>();
            decodedState.decode(state.encode());

            let onArrayAddCalled = 0;

            decodedState.arrayOfStrings.onAdd((str, key) => onArrayAddCalled++);
            // decodedState.arrayOfStrings.triggerAll();

            assert.strictEqual(2, onArrayAddCalled, "onAdd should've been called twice.");
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

            const onRemoveSpy = sinon.spy(() => {});
            decodedState.mapOfPlayers.onRemove(onRemoveSpy);

            decodedState.decode(state.encodeAll());

            sinon.assert.notCalled(onRemoveSpy);
        });
    });

    describe("callback order", () => {
        class MyState extends Schema {
            @type("string") str: string;
            @type("number") num: number;
            @type(["number"]) arrOfNumbers = new ArraySchema<number>();
            @type([Player]) arrOfPlayers = new ArraySchema<Player>();
            @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
        }

        it("previous fields should be available during later field's callbacks", () => {
            const state = new MyState();

            state.str = "Hello world";
            state.num = 10;

            state.arrOfNumbers.push(10);
            state.arrOfNumbers.push(20);

            state.arrOfPlayers.push(new Player("Jake", 0, 0));
            state.arrOfPlayers.push(new Player("Snake", 10, 10));

            state.mapOfPlayers['katarina'] = new Player("Katarina", 20, 20);

            const decodedState = new MyState();

            let strs: string[] = [];
            let nums: number[] = [];
            let mapOfPlayersDuringArrOfPlayers: number[] = [];

            decodedState.arrOfPlayers.onAdd(function(item, index) {
                strs.push(decodedState.str);
                nums.push(decodedState.num);
                mapOfPlayersDuringArrOfPlayers.push(Object.keys(decodedState.mapOfPlayers).length);
            });

            const encoded = state.encode();

            // console.log(util.inspect(encoded, true, 4));
            decodedState.decode(encoded);

            assert.deepEqual(strs, ["Hello world", "Hello world"]);
            assert.deepEqual(nums, [10, 10]);
        });

    });

    describe("propagante change to parent structure", () => {
        xit("Array -> Schema should trigger onChange on Array", () => {
            class Item extends Schema {
                @type("number") qty: number = 1;
            }
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            state.items = new ArraySchema();
            state.items.push(new Item().assign({ qty: 1 }));
            state.items.push(new Item().assign({ qty: 1 }));
            state.items.push(new Item().assign({ qty: 1 }));

            const decodedState = new State();
            decodedState.decode(state.encode());

            const onChangeSpy = sinon.spy((item, key) => {});
            decodedState.items.onChange(onChangeSpy);

            state.items[0].qty++;
            state.items[1].qty++;
            state.items[2].qty++;

            decodedState.decode(state.encode());

            //
            // This is not supported anymore since colyseus/schema@1.0.0
            //
            sinon.assert.callCount(onChangeSpy, 3);
        });

    });

    describe(".listen()", () => {
        it("TypeScript should recognize boolean properties", () => {
            class State extends Schema {
                @type("boolean")
                bool: boolean;
            }

            const state = new State();
            state.listen("bool", () => {});

            assert.ok(true, "This piece of code should compile.");
        });

        it("Edge case: using a .map property name", () => {
            let listenCount: number = 0;
            let onChangeCount: number = 0;

            class MyMap extends Schema {
                @type("string") prop1: string;
            }
            class MapHolder extends Schema {
                @type(MyMap) map = new MyMap();
            }
            class State extends Schema {
                @type({map: MapHolder}) users = new MapSchema<MapHolder>();
            }

            const state = new State();
            state.users.set("one", new MapHolder());
            state.users.get("one").map.prop1 = "Hello world";

            const decodedState = new State();
            decodedState.users.onAdd((user) => {
                user.onChange(() => onChangeCount++);
                user.map.listen("prop1", () => listenCount++);
            });
            decodedState.decode(state.encode());

            state.users.get("one").map.prop1 = "Changed...";
            decodedState.decode(state.encode());

            assert.strictEqual(2, listenCount);
            assert.strictEqual(1, onChangeCount);
        })
    });

});
