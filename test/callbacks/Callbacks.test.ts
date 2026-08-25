import * as assert from "assert";

import { Schema, type, view, ArraySchema, MapSchema } from "../../src";
import { createClientWithView, createInstanceFromReflection, encodeMultiple, getDecoder, getEncoder } from "../Schema";
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

        it("should not register onAdd callback twice when collection becomes available", () => {
            class Player extends Schema {
                @type("string") name: string;
            }

            class State extends Schema {
                @type({ map: Player }) players: MapSchema<Player>;
            }

            const state = new State();
            // Initially no players collection (undefined)

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            let addCount = 0;
            const addedNames: string[] = [];

            // Register onAdd while collection is NOT available
            callbacks.onAdd(
                "players",
                (player, sessionId) => {
                    addCount++;
                    addedNames.push(player.name);
                }
            );

            // First decode - no collection yet
            decodedState.decode(state.encode());
            assert.strictEqual(addCount, 0);

            // Now set the collection with a player
            state.players = new MapSchema<Player>();
            state.players.set("one", new Player().assign({ name: "Alice" }));
            decodedState.decode(state.encodeAll());
            decodedState.decode(state.encode());

            // Should be called exactly once for Alice
            assert.strictEqual(addCount, 1, `Expected addCount to be 1, but was ${addCount}. Names: ${addedNames.join(", ")}`);

            // Add another player to the same collection
            state.players.set("two", new Player().assign({ name: "Bob" }));
            decodedState.decode(state.encode());

            // Should be called once for Bob (total 2)
            assert.strictEqual(addCount, 2, `Expected addCount to be 2, but was ${addCount}. Names: ${addedNames.join(", ")}`);

            // Add another player to the same collection
            state.players.set("three", new Player().assign({ name: "Charlie" }));
            decodedState.decode(state.encode());

            // Should be called once for Charlie (total 3)
            assert.strictEqual(addCount, 3, `Expected addCount to be 3, but was ${addCount}. Names: ${addedNames.join(", ")}`);
        });

        it("DELETE_BY_REFID for an unseen filtered ArraySchema item must not trigger onRemove", () => {
            // Reproduces the case documented at Callbacks.ts: a client whose
            // @view subscription never included a given ArraySchema item still
            // receives a DELETE_BY_REFID when the server removes it. The push
            // site in decodeArray is unconditional (previousValue: undefined),
            // and the dispatcher guard must prevent onRemove(undefined, key).
            class Item extends Schema {
                @type("number") amount: number;
            }

            class State extends Schema {
                @view() @type([Item]) items = new ArraySchema<Item>();
            }

            const state = new State();
            for (let i = 0; i < 3; i++) {
                state.items.push(new Item().assign({ amount: i }));
            }

            const encoder = getEncoder(state);

            // client1 only ever sees items[1].
            const client1 = createClientWithView(state);
            client1.view.add(state.items.at(1));

            // client2 sees the entire array (so the server actually emits the
            // DELETE for items[0] on the wire).
            const client2 = createClientWithView(state);
            client2.view.add(state.items);

            const callbacks = Callbacks.get(client1.decoder);

            const addedAmounts: number[] = [];
            const removedAmounts: any[] = [];

            callbacks.onAdd("items", (item) => addedAmounts.push(item.amount));
            callbacks.onRemove("items", (item) => removedAmounts.push(item?.amount));

            assert.doesNotThrow(() => {
                encodeMultiple(encoder, state, [client1, client2]);
            });

            assert.deepStrictEqual(addedAmounts, [1]);
            assert.deepStrictEqual(removedAmounts, []);

            // Now splice the unseen items[0] — client1 receives DELETE_BY_REFID
            // for a refId it never had. onRemove must NOT fire on client1.
            state.items.splice(0, 1);

            assert.doesNotThrow(() => {
                encodeMultiple(encoder, state, [client1, client2]);
            });

            assert.deepStrictEqual(addedAmounts, [1], "onAdd must not fire for the unseen refId");
            assert.deepStrictEqual(removedAmounts, [], "onRemove must not fire with undefined previousValue");
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

    //
    // Simulates the situation where two distinct copies of @colyseus/schema
    // are installed in node_modules. When that happens, the user's `data`
    // is no longer typed as the *local* Schema subclass — TypeScript infers
    // a structural shape that doesn't extend the local Schema class, because
    // the underlying ref came from a different copy of the package.
    //
    // Before the constraint relaxation on the callbacks API, the nested
    // overloads were declared as `<TInstance extends Schema, ...>`. A
    // structural type that doesn't extend the local Schema fails the
    // constraint, so `TInstance` collapses to `Schema<any>`,
    // `CollectionPropNames<TInstance>` evaluates to `never`, and
    // `_.onAdd(data, "playingUsers", ...)` fails with the famous
    // "is not assignable to parameter of type 'never'" error.
    //
    // We reproduce that exact shape with a structural-only interface. If the
    // API ever re-tightens its constraints to `extends Schema`, this file
    // will fail to compile.
    //
    describe("cross-version Schema (multiple @colyseus/schema in node_modules)", () => {
        // The shape TS infers for `data` when the ref was constructed by a
        // different copy of @colyseus/schema. It has the on-wire `~refId`
        // property and the user's own fields, but does NOT structurally
        // match the local `Schema` class (no `assign`, `toJSON`, etc).
        interface DualVersionRef {
            ["~refId"]?: number;
        }

        it("should accept a structurally-typed cross-version ref", () => {
            class Player extends Schema {
                @type("string") sessionId: string;
                @type("number") hp: number;
            }

            class State extends Schema {
                @type({ array: Player }) players = new ArraySchema<Player>();
                @type({ map: Player }) byId = new MapSchema<Player>();
                @type(Player) leader: Player;
            }

            const state = new State();
            state.players.push(new Player().assign({ sessionId: "a", hp: 100 }));
            state.byId.set("a", state.players[0]);
            state.leader = state.players[0];

            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            // Same identity as `decodedState`, but typed as it would be under
            // a dual-install: a structural shape that doesn't extend Schema.
            type DualState = {
                players: ArraySchema<Player>;
                byId: MapSchema<Player>;
                leader: Player;
            } & DualVersionRef;
            const dualState = decodedState as unknown as DualState;

            let collectionAdds = 0;
            let mapAdds = 0;
            let leaderChanges = 0;
            let leaderListenFired = false;

            // onAdd on a nested array — the original failing pattern
            callbacks.onAdd(dualState, "players", () => { collectionAdds++; });

            // onAdd on a nested map
            callbacks.onAdd(dualState, "byId", (_player, key) => {
                mapAdds++;
                assert.ok(typeof key === "string");
            });

            // onChange on a nested instance (no property — the 2-arg overload
            // that needs `extends object` to disambiguate from a string property)
            callbacks.onChange(dualState, () => { leaderChanges++; });

            // onRemove on a nested collection
            callbacks.onRemove(dualState, "players", () => { /* type-check only */ });

            // listen on a nested property
            callbacks.listen(dualState, "leader", () => { leaderListenFired = true; });

            // bindTo with a dual-version-typed source
            const visual: any = {};
            callbacks.bindTo(dualState, visual);

            decodedState.decode(state.encode());

            assert.strictEqual(collectionAdds, 1, "onAdd(array) should fire");
            assert.strictEqual(mapAdds, 1, "onAdd(map) should fire");
            assert.ok(leaderChanges >= 1, "onChange(instance) should fire");
            assert.ok(leaderListenFired, "listen(instance, prop) should fire");
        });

        it("should preserve property-name autocompletion on cross-version refs", () => {
            class State extends Schema {
                @type("string") name: string;
                @type({ array: "string" }) tags = new ArraySchema<string>();
            }

            const state = new State();
            const decodedState = createInstanceFromReflection(state);
            const decoder = getDecoder(decodedState);
            const callbacks = Callbacks.get(decoder);

            type DualState = {
                name: string;
                tags: ArraySchema<string>;
            } & DualVersionRef;
            const dualState = decodedState as unknown as DualState;

            // Valid property and collection still work
            callbacks.listen(dualState, "name", () => {});
            callbacks.onAdd(dualState, "tags", () => {});

            // The lines below are commented out because they SHOULD fail to
            // type-check. Uncomment to manually verify the property/collection
            // constraints are still doing their job:
            //
            // @ts-expect-error — "missing" is not a property of DualState
            callbacks.listen(dualState, "missing", () => {});
            // @ts-expect-error — "name" is not a collection
            callbacks.onAdd(dualState, "name", () => {});

            assert.ok(true);
        });
    });
});

