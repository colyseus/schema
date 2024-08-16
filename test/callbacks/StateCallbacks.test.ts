import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema, getDecoderStateCallbacks, decodeSchemaOperation, Decoder } from "../../src";
import { createInstanceFromReflection, getCallbacks, getDecoder } from "../Schema";

describe("StateCallbacks", () => {

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

    it("should support nested onAdd, attached BEFORE data is available ", () => {
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
        let onItemAddCount = 0;
        let onPropertyAddCount = 0;

        $(decodedState).players.onAdd((player, key) => {
            onPlayerAddCount++;

            $(player).items.onAdd((item, key) => {
                onItemAddCount++;

                $(item).properties.onAdd((prop, key) => {
                    onPropertyAddCount++;
                });
            });
        });

        decodedState.decode(state.encode());
        assert.strictEqual(1, onPlayerAddCount);
        assert.strictEqual(2, onItemAddCount);
        assert.strictEqual(4, onPropertyAddCount);
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
        let onItemAddCount = 0;
        let onPropertyAddCount = 0;

        decodedState.decode(state.encode());

        $(decodedState).players.onAdd((player, key) => {
            onPlayerAddCount++;

            $(player).items.onAdd((item, key) => {
                onItemAddCount++;

                $(item).properties.onAdd((prop, key) => {
                    onPropertyAddCount++;
                });
            });
        });

        assert.strictEqual(1, onPlayerAddCount);
        assert.strictEqual(2, onItemAddCount);
        assert.strictEqual(4, onPropertyAddCount);
    });

});