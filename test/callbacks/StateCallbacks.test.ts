import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema, getDecoderStateCallbacks, decodeSchemaOperation, Decoder } from "../../src";
import { createInstanceFromReflection, getCallbacks, getDecoder } from "../Schema";
import { SchemaCallbackProxy } from "../../src/decoder/strategy/StateCallbacks";

describe("StateCallbacks", () => {

    it("TypeScript type inference", () => {
        class Item extends Schema {
            @type("number") amount: number;
        }
        class State extends Schema {
            @type([Item]) items = new ArraySchema<Item>();
            @type('int64') actionType: number;
        }
        const state = new State();
        const decodedState = createInstanceFromReflection(state);
        const decoder = getDecoder(decodedState);

        const $ = getDecoderStateCallbacks(decoder);
        const ref$: SchemaCallbackProxy<State> = $;

        assert.strictEqual($, ref$);
    });

    it("should trigger changes in order they've been originally made", () => {
        class State extends Schema {
            @type(['string']) boardTiles = new ArraySchema<string>();
            @type('int64') actionType: number;
        }

        const state = new State();

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        const $ = getCallbacks(decodedState);

        state.boardTiles.push('one');
        state.actionType = 1;

        const actionOrder: any[] = [];

        $(decodedState).boardTiles.onAdd((item, key) => actionOrder.push("boardTiles.onAdd"));
        $(decodedState).listen('actionType', (curr, prev) => actionOrder.push("actionType"));

        decodedState.decode(state.encode());

        assert.deepStrictEqual(actionOrder, ["boardTiles.onAdd", "actionType"]);
    });

    it("should bind changes into another object", () => {
        class Player extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const player = new Player().assign({ x: 10, y: 10 });
        state.players.set("one", player);

        const decodedState = createInstanceFromReflection(state);
        const bound: any = {};

        const $ = getCallbacks(decodedState);

        $(decodedState).players.onAdd((player, key) => {
            $(player).bindTo(bound);
        });

        decodedState.decode(state.encode());

        assert.strictEqual(10, bound.x);
        assert.strictEqual(10, bound.y);

        player.x = 20;
        player.y = 30;

        decodedState.decode(state.encode());

        assert.strictEqual(20, bound.x);
        assert.strictEqual(30, bound.y);
    });

    it("should support nested onAdd, attached BEFORE data is available", () => {
        class Prop extends Schema {
            @type("number") lvl: number;
        }

        class Item extends Schema {
            @type("string") type: string;
            @type({ map: Prop }) properties = new MapSchema<Prop>();
        }

        class Player extends Schema {
            @type("string") name: string;
            @type({ map: Item }) items = new MapSchema<Item>();
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const player = new Player().assign({
            name: "Player one",
            items: new MapSchema<Item>({
                sword: new Item().assign({
                    type: 'sword',
                    properties: new MapSchema<Prop>({
                        "one": new Prop().assign({ lvl: 1 }),
                        "two": new Prop().assign({ lvl: 2 }),
                    })
                }),
                shield: new Item().assign({
                    type: 'shield' ,
                    properties: new MapSchema<Prop>({
                        "three": new Prop().assign({ lvl: 3 }),
                        "four": new Prop().assign({ lvl: 4 }),
                    })
                }),
            })
        });
        state.players.set("one", player);

        const decodedState = createInstanceFromReflection(state);
        const $ = getCallbacks(decodedState);

        let onPlayerAddCount = 0;
        let onPlayerListen = 0;

        let onItemAddCount = 0;
        let onItemListen = 0

        let onPropertyAddCount = 0;
        let onPropertyListen = 0;

        $(decodedState).players.onAdd((player, key) => {
            onPlayerAddCount++;

            $(player).listen("name", () => onPlayerListen++);

            $(player).items.onAdd((item, key) => {
                onItemAddCount++;

                $(item).listen("type", () => onItemListen++);

                $(item).properties.onAdd((prop, key) => {

                    $(prop).listen("lvl", () => onPropertyListen++);

                    onPropertyAddCount++;
                });
            });
        });

        decodedState.decode(state.encode());
        assert.strictEqual(1, onPlayerAddCount);
        assert.strictEqual(1, onPlayerListen);

        assert.strictEqual(2, onItemAddCount);
        assert.strictEqual(2, onItemListen);

        assert.strictEqual(4, onPropertyAddCount);
        assert.strictEqual(4, onPropertyListen);
    });

    it("should support nested onAdd, attached AFTER data is available ", () => {
        class Prop extends Schema {
            @type("number") lvl: number;
        }

        class Item extends Schema {
            @type("string") type: string;
            @type({ map: Prop }) properties = new MapSchema<Prop>();
        }

        class Player extends Schema {
            @type("string") name: string;
            @type({ map: Item }) items = new MapSchema<Item>();
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();
        const player = new Player().assign({
            name: "Player one",
            items: new MapSchema<Item>({
                sword: new Item().assign({
                    type: 'sword',
                    properties: new MapSchema<Prop>({
                        "one": new Prop().assign({ lvl: 1 }),
                        "two": new Prop().assign({ lvl: 2 }),
                    })
                }),
                shield: new Item().assign({
                    type: 'shield' ,
                    properties: new MapSchema<Prop>({
                        "three": new Prop().assign({ lvl: 3 }),
                        "four": new Prop().assign({ lvl: 4 }),
                    })
                }),
            })
        });

        state.players.set("one", player);

        const decodedState = createInstanceFromReflection(state);
        const $ = getCallbacks(decodedState);

        let onPlayerAddCount = 0;
        let onPlayerListen = 0;

        let onItemAddCount = 0;
        let onItemListen = 0

        let onPropertyAddCount = 0;
        let onPropertyListen = 0;

        decodedState.decode(state.encode());

        $(decodedState).players.onAdd((player, key) => {
            onPlayerAddCount++;

            $(player).listen("name", () => onPlayerListen++);

            $(player).items.onAdd((item, key) => {
                onItemAddCount++;

                $(item).listen("type", () => onItemListen++);

                $(item).properties.onAdd((prop, key) => {

                    $(prop).listen("lvl", () => onPropertyListen++);

                    onPropertyAddCount++;
                });
            });
        });

        assert.strictEqual(1, onPlayerAddCount);
        assert.strictEqual(1, onPlayerListen);

        assert.strictEqual(2, onItemAddCount);
        assert.strictEqual(2, onItemListen);

        assert.strictEqual(4, onPropertyAddCount);
        assert.strictEqual(4, onPropertyListen);
    });

    describe("ArraySchema", () => {
        it("consecutive shift + unshift should trigger onAdd at 0 index", () => {
            class Card extends Schema {
                @type("string") suit: string;
                @type("number") num: number;
            }
            class State extends Schema {
                @type([Card]) deck = new ArraySchema<Card>();
                @type([Card]) discardPile = new ArraySchema<Card>();
            }

            const state = new State();
            const decodedState = createInstanceFromReflection(state);

            // create a deck of cards
            for (let i = 0; i < 13; i++) {
                state.deck.push(new Card().assign({ suit: "hearts", num: i }));
            }

            decodedState.decode(state.encode());

            let onChange: number[] = [];
            let onAdd: number[] = [];

            const $ = getCallbacks(decodedState);
            $(decodedState).discardPile.onChange((item, index) => onChange.push(index));
            $(decodedState).discardPile.onAdd((item, index) => onAdd.push(index));

            for (let i=0; i<3; i++) {
                state.discardPile.unshift(state.deck.shift());
                decodedState.decode(state.encode());
            }

            assert.deepStrictEqual(onChange, [0, 0, 0]);
            assert.deepStrictEqual(onAdd, [0, 0, 0]);
        });

    })

});