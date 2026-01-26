import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema } from "../../src";
import { createInstanceFromReflection, getDecoder } from "../Schema";
import { Callbacks } from "../../src/decoder/strategy/Callbacks";

/**
 * Tests for the new Callbacks API (similar to the C#-style API)
 */
describe("Callbacks (new API)", () => {

    describe("listen", () => {
        it("should listen to property changes on root state using selector", () => {
            class State extends Schema {
                @type("number") currentTurn: number;
                @type("string") name: string;
            }

            const state = new State();
            state.currentTurn = 1;
            state.name = "Test";

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let currentValue: number | undefined;
            let previousValue: number | undefined;

            // C# style: callbacks.listen("currentTurn", (current, previous) => { ... });
            callbacks.listen(
                "currentTurn",
                (current, previous) => {
                    currentValue = current;
                    previousValue = previous;
                }
            );

            decodedState.decode(state.encode());

            // Should trigger immediately with initial value
            assert.strictEqual(currentValue, 1);
            assert.strictEqual(previousValue, undefined);

            // Change value
            state.currentTurn = 2;
            decodedState.decode(state.encode());

            assert.strictEqual(currentValue, 2);
            assert.strictEqual(previousValue, 1);
        });

        it("should listen to nested instance property changes", () => {
            class Player extends Schema {
                @type("number") hp: number;
                @type("string") name: string;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            const player = new Player().assign({ hp: 100, name: "Alice" });
            state.players.set("one", player);

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let hpValue: number | undefined;
            let hpPrevious: number | undefined;

            // C# style: callbacks.onAdd("players", (player, sessionId) => {
            //     callbacks.listen(player, "hp", (current, previous) => { ... });
            // });
            callbacks.onAdd(
                "players",
                (playerInstance, sessionId) => {
                    callbacks.listen(
                        playerInstance,
                        "hp",
                        (current, previous) => {
                            hpValue = current;
                            hpPrevious = previous;
                        }
                    );
                }
            );

            decodedState.decode(state.encode());

            assert.strictEqual(hpValue, 100);
            assert.strictEqual(hpPrevious, undefined);

            player.hp = 80;
            decodedState.decode(state.encode());

            assert.strictEqual(hpValue, 80);
            assert.strictEqual(hpPrevious, 100);
        });

        it("should return a function to detach the listener", () => {
            class State extends Schema {
                @type("number") value: number;
            }

            const state = new State();
            state.value = 1;

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let callCount = 0;

            const unbind = callbacks.listen(
                "value",
                () => callCount++
            );

            decodedState.decode(state.encode());
            assert.strictEqual(callCount, 1);

            // Detach the listener
            unbind();

            state.value = 2;
            decodedState.decode(state.encode());

            // Should not be called after unbinding
            assert.strictEqual(callCount, 1);
        });
    });

    describe("onAdd / onRemove", () => {
        it("should trigger onAdd with (value, key) parameter order", () => {
            class Player extends Schema {
                @type("string") name: string;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            state.players.set("sessionId123", new Player().assign({ name: "Alice" }));

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let addedKey: string | undefined;
            let addedPlayer: Player | undefined;

            // C# style: callbacks.onAdd("players", (player, sessionId) => { ... });
            callbacks.onAdd(
                "players",
                (player, sessionId) => {
                    addedPlayer = player;
                    addedKey = sessionId;
                }
            );

            decodedState.decode(state.encode());

            assert.strictEqual(addedKey, "sessionId123");
            assert.strictEqual(addedPlayer?.name, "Alice");
        });

        it("should trigger onRemove with (value, key) parameter order", () => {
            class Player extends Schema {
                @type("string") name: string;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            state.players.set("sessionId123", new Player().assign({ name: "Alice" }));

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let removedKey: string | undefined;
            let removedPlayer: Player | undefined;

            callbacks.onAdd("players", () => {});
            callbacks.onRemove(
                "players",
                (player, sessionId) => {
                    removedPlayer = player;
                    removedKey = sessionId;
                }
            );

            decodedState.decode(state.encode());

            state.players.delete("sessionId123");
            decodedState.decode(state.encode());

            assert.strictEqual(removedKey, "sessionId123");
            assert.strictEqual(removedPlayer?.name, "Alice");
        });

        it("should work with ArraySchema", () => {
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            state.items.push(new Item().assign({ amount: 10 }));
            state.items.push(new Item().assign({ amount: 20 }));

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            const addedIndexes: number[] = [];
            const addedAmounts: number[] = [];

            callbacks.onAdd(
                "items",
                (item, index) => {
                    addedAmounts.push(item.amount);
                    addedIndexes.push(index);
                }
            );

            decodedState.decode(state.encode());

            assert.deepStrictEqual(addedIndexes, [0, 1]);
            assert.deepStrictEqual(addedAmounts, [10, 20]);
        });
    });

    describe("onChange", () => {
        it("should trigger onChange on instance when any property changes", () => {
            class Player extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }

            class State extends Schema {
                @type(Player) player: Player;
            }

            const state = new State();
            state.player = new Player().assign({ x: 10, y: 20 });

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let onChangeCount = 0;

            decodedState.decode(state.encode());

            // C# style: callbacks.onChange(entity, () => { ... });
            callbacks.onChange(
                decodedState.player,
                () => { onChangeCount++; }
            );

            state.player.x = 15;
            decodedState.decode(state.encode());

            assert.strictEqual(onChangeCount, 1);

            state.player.y = 25;
            decodedState.decode(state.encode());

            assert.strictEqual(onChangeCount, 2);
        });

        it("should trigger onChange on collection with (key, value)", () => {
            class State extends Schema {
                @type({ map: "string" }) data = new MapSchema<string>();
            }

            const state = new State();
            state.data.set("key1", "value1");

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            const changes: { key: string; value: string }[] = [];

            callbacks.onChange(
                "data",
                (key, value) => {
                    changes.push({ key, value });
                }
            );

            decodedState.decode(state.encode());

            // First add triggers onChange
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].key, "key1");
            assert.strictEqual(changes[0].value, "value1");

            // Update value
            state.data.set("key1", "updated");
            decodedState.decode(state.encode());

            assert.strictEqual(changes.length, 2);
            assert.strictEqual(changes[1].key, "key1");
            assert.strictEqual(changes[1].value, "updated");
        });
    });

    describe("bindTo", () => {
        it("should bind properties to target object", () => {
            class Player extends Schema {
                @type("number") x: number;
                @type("number") y: number;
                @type("string") name: string;
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            const state = new State();
            state.players.set("one", new Player().assign({ x: 10, y: 20, name: "Alice" }));

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            const visualObject: any = {};

            // C# style: callbacks.bindTo(player, playerVisual);
            callbacks.onAdd(
                "players",
                (player, sessionId) => {
                    callbacks.bindTo(player, visualObject);
                }
            );

            decodedState.decode(state.encode());

            assert.strictEqual(visualObject.x, 10);
            assert.strictEqual(visualObject.y, 20);
            assert.strictEqual(visualObject.name, "Alice");

            // Update values
            state.players.get("one")!.x = 15;
            state.players.get("one")!.y = 25;
            decodedState.decode(state.encode());

            assert.strictEqual(visualObject.x, 15);
            assert.strictEqual(visualObject.y, 25);
        });

        it("should bind only specified properties", () => {
            class Player extends Schema {
                @type("number") x: number;
                @type("number") y: number;
                @type("string") name: string;
            }

            class State extends Schema {
                @type(Player) player: Player;
            }

            const state = new State();
            state.player = new Player().assign({ x: 10, y: 20, name: "Alice" });

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            decodedState.decode(state.encode());

            const visualObject: any = {};

            // Bind only x and y
            callbacks.bindTo(decodedState.player, visualObject, ["x", "y"]);

            // Initial bind
            assert.strictEqual(visualObject.x, 10);
            assert.strictEqual(visualObject.y, 20);
            assert.strictEqual(visualObject.name, undefined); // name not bound

            state.player.x = 15;
            state.player.name = "Bob";
            decodedState.decode(state.encode());

            assert.strictEqual(visualObject.x, 15);
            assert.strictEqual(visualObject.name, undefined); // still undefined
        });
    });

    describe("nested callbacks", () => {
        it("should support deeply nested callbacks matching C# example", () => {
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
                @type({ map: Player }) entities = new MapSchema<Player>();
            }

            const state = new State();
            const player = new Player().assign({
                name: "Player one",
                items: new MapSchema<Item>({
                    sword: new Item().assign({
                        type: 'sword',
                        properties: new MapSchema<Prop>({
                            "strength": new Prop().assign({ lvl: 5 }),
                        })
                    }),
                })
            });
            state.entities.set("player1", player);

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let entityAddCount = 0;
            let itemAddCount = 0;
            let propAddCount = 0;
            let propLvlValue: number | undefined;

            // C# style nested callbacks
            callbacks.onAdd(
                "entities",
                (entity, sessionId) => {
                    entityAddCount++;

                    callbacks.listen(
                        entity,
                        "name",
                        (current, previous) => {
                            // name change handler
                        }
                    );

                    callbacks.onAdd(
                        entity,
                        "items",
                        (item, itemKey) => {
                            itemAddCount++;

                            callbacks.onAdd(
                                item,
                                "properties",
                                (prop, propKey) => {
                                    propAddCount++;

                                    callbacks.listen(
                                        prop,
                                        "lvl",
                                        (current, previous) => {
                                            propLvlValue = current;
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );

            decodedState.decode(state.encode());

            assert.strictEqual(entityAddCount, 1);
            assert.strictEqual(itemAddCount, 1);
            assert.strictEqual(propAddCount, 1);
            assert.strictEqual(propLvlValue, 5);

            // Update property level
            player.items.get("sword")!.properties.get("strength")!.lvl = 10;
            decodedState.decode(state.encode());

            assert.strictEqual(propLvlValue, 10);
        });
    });

    describe("TypeScript type inference", () => {
        it("should properly infer types from property names", () => {
            class State extends Schema {
                @type("number") count: number;
                @type("string") name: string;
            }

            const state = new State();
            state.count = 42;
            state.name = "test";

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            // This should compile without errors - TypeScript should infer the type
            callbacks.listen(
                "count",
                (current: number, previous: number) => {
                    // Type should be number
                    const sum = current + 1;
                    assert.ok(typeof sum === "number");
                }
            );

            callbacks.listen(
                "name",
                (current: string, previous: string) => {
                    // Type should be string
                    const upper = current.toUpperCase();
                    assert.ok(typeof upper === "string");
                }
            );

            decodedState.decode(state.encode());
        });
    });
});

