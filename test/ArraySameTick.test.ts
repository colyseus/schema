import * as assert from "assert";

import { State, Player, getCallbacks, getEncoder, createInstanceFromReflection, getDecoder, assertDeepStrictEqualEncodeAll, assertRefIdCounts, assertNoOrphanRefs, createClientWithView, encodeMultiple } from "./Schema";
import { ArraySchema, Schema, type, view, $changes, $refId, MapSchema, ChangeTree, schema, t } from "../src";

// Ported from 5.0.28 (master 9ceee28). v6 folds a same-tick add + remove in
// the ArrayLog, so only the client-visible contract carries over: the 5.x
// patch-size assertions are dropped, and refCounts are read from RefTables.
describe("ArraySchema", () => {
    describe("same-tick add + remove of Schema children", () => {
        describe("shared instance refCount", () => {
            class Child extends Schema {
                @type("string") kind = "bag";
            }
            class Entity extends Schema {
                @type("string") name = "";
                @type(Child) child: Child;
            }
            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
                @type([Entity]) list = new ArraySchema<Entity>();
            }

            function setup() {
                const state = new State();
                const encoder = getEncoder(state);
                const decodedState = createInstanceFromReflection(state);
                const decoder = getDecoder(decodedState);
                return { state, encoder, decodedState, decoder };
            }

            const entity = () => Object.assign(new Entity(), { name: "e0", child: new Child() });

            for (const [label, remove] of [
                ["splice()", (list: ArraySchema<Entity>) => list.splice(0, 1)],
                ["pop()", (list: ArraySchema<Entity>) => list.pop()],
                ["shift()", (list: ArraySchema<Entity>) => list.shift()],
            ] as const) {
                it(`push + ${label} in the same tick must not drop the shared instance's refCount`, () => {
                    const { state, encoder, decodedState, decoder } = setup();

                    const e = entity();
                    state.entities.set("e0", e);
                    state.list.push(e);
                    remove(state.list);

                    decodedState.decode(state.encode());

                    const refId = e[$refId];
                    assert.strictEqual(
                        decoder.root.refCount.get(refId),
                        encoder.root.refCount.get(refId),
                        `refCount diverged for the entity still held by 'entities'`
                    );
                    assert.ok(decoder.root.refs.has(refId), "decoder dropped a live reference");
                    assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
                });
            }

            it("does not warn when the instance is later removed for real", () => {
                const { state, decodedState } = setup();

                const e = entity();
                state.entities.set("e0", e);
                state.list.push(e);
                state.list.splice(0, 1);
                decodedState.decode(state.encode());

                const warnings: string[] = [];
                const originalWarn = console.warn;
                console.warn = (...args: any[]) => warnings.push(String(args[0]));
                try {
                    state.entities.delete("e0");
                    decodedState.decode(state.encode());
                } finally {
                    console.warn = originalWarn;
                }

                assert.deepStrictEqual(warnings, []);
                assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
            });

            it("does not disturb an instance the client already knows", () => {
                const { state, encoder, decodedState, decoder } = setup();

                const e = entity();
                state.entities.set("e0", e);
                decodedState.decode(state.encode());

                const refId = e[$refId];
                assert.strictEqual(decoder.root.refCount.get(refId), 1);

                // transient visit to the array, a tick after the entity became known
                state.list.push(e);
                state.list.splice(0, 1);

                const patch = state.encode();
                assert.strictEqual(patch.byteLength, 0, "nothing changed — the patch must be empty");

                decodedState.decode(patch);
                assert.strictEqual(decoder.root.refCount.get(refId), encoder.root.refCount.get(refId));
                assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
            });

            it("still deletes an item the client did receive", () => {
                const { state, encoder, decodedState, decoder } = setup();

                const e = entity();
                state.entities.set("e0", e);
                state.list.push(e);
                decodedState.decode(state.encode());
                assert.strictEqual(decodedState.list.length, 1);

                state.list.splice(0, 1);
                decodedState.decode(state.encode());

                const refId = e[$refId];
                assert.strictEqual(decodedState.list.length, 0);
                assert.strictEqual(decoder.root.refCount.get(refId), encoder.root.refCount.get(refId));
                assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
            });

            it("clear() in the same tick is unaffected", () => {
                const { state, encoder, decodedState, decoder } = setup();

                const e = entity();
                state.entities.set("e0", e);
                state.list.push(e);
                state.list.clear();

                decodedState.decode(state.encode());

                const refId = e[$refId];
                assert.strictEqual(decoder.root.refCount.get(refId), encoder.root.refCount.get(refId));
                assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
            });
        });

        describe("staged layout", () => {
            class Item extends Schema {
                @type("string") name = "";
            }
            class State extends Schema {
                @type([Item]) list = new ArraySchema<Item>();
            }

            const item = (name: string) => Object.assign(new Item(), { name });
            const names = (arr: ArraySchema<Item>) => Array.from(arr).map((i) => i.name);

            /** Client bootstrapped with `list = [a, b, ...]` (one name per entry). */
            function bootstrapped(...initial: string[]) {
                const state = new State();
                const encoder = getEncoder(state);
                const decodedState = createInstanceFromReflection(state);
                const decoder = getDecoder(decodedState);
                state.list.push(...initial.map(item));
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), initial);
                return { state, encoder, decodedState, decoder };
            }

            function assertInSync(state: State, decodedState: State) {
                assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
                assertRefIdCounts(state, decodedState);
                assertNoOrphanRefs(state, decodedState);
            }

            // The cases that only slot erasure fixes: the cancelled slot is *inside*
            // the client's range, so a suppressed DELETE would leave ADD@1 to
            // splice-insert at an occupied index.
            it("unshift two, shift one: the survivor lands at index 0", () => {
                const { state, decodedState } = bootstrapped("a", "b");
                state.list.unshift(item("X"), item("Y"));
                state.list.shift();
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["Y", "a", "b"]);
                assertInSync(state, decodedState);
            });

            it("unshift then splice-replace at 0: the client keeps its first element", () => {
                const { state, decodedState } = bootstrapped("a", "b", "c");
                state.list.unshift(item("P"));
                state.list.splice(0, 1, item("Y"));
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["Y", "a", "b", "c"]);
                assertInSync(state, decodedState);
            });

            it("unshift twice, shift once", () => {
                const { state, decodedState } = bootstrapped("a", "b", "c");
                state.list.unshift(item("X"));
                state.list.unshift(item("Z"));
                state.list.shift();
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["X", "a", "b", "c"]);
                assertInSync(state, decodedState);
            });

            it("push then splice-replace the pushed slot", () => {
                const { state, decodedState } = bootstrapped("a", "b", "c");
                state.list.push(item("X"));
                state.list.splice(3, 1, item("Y"));
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["a", "b", "c", "Y"]);
                assertInSync(state, decodedState);
            });

            it("push then splice a range that excludes the pushed slot", () => {
                const { state, decodedState } = bootstrapped("a", "b", "c");
                state.list.push(item("X"));
                state.list.splice(1, 2, item("Y"));
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["a", "Y", "X"]);
                assertInSync(state, decodedState);
            });

            it("push then splice a range that ends on the pushed slot", () => {
                const { state, decodedState } = bootstrapped("a", "b", "c");
                state.list.push(item("X"));
                state.list.splice(2, 2);
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["a", "b"]);
                assertInSync(state, decodedState);
            });

            it("primitive arrays: push + pop in one tick leaves the client unchanged", () => {
                class Prim extends Schema {
                    @type(["string"]) list = new ArraySchema<string>();
                }
                const state = new Prim();
                const decodedState = createInstanceFromReflection(state);
                state.list.push("a", "b");
                decodedState.decode(state.encode());

                state.list.push("X");
                state.list.pop();
                decodedState.decode(state.encode());
                assert.deepStrictEqual(Array.from(decodedState.list), ["a", "b"]);
            });

            it("a full sync inside the tick makes the pending indexes load-bearing", () => {
                // encodeAll() emits from `items` without draining `collDirty`, so the
                // client already holds every pending slot positionally. Cancelling one
                // would shift the rest down and splice-insert at occupied indexes.
                const state = new State();
                const encoder = getEncoder(state);
                const decodedState = createInstanceFromReflection(state);
                state.list.push(item("a"), item("b"), item("c"), item("d"));
                decodedState.decode(encoder.encodeAll()); // no discardChanges
                state.list.splice(1, 1);
                decodedState.decode(state.encode());
                assert.deepStrictEqual(names(decodedState.list), ["a", "c", "d"]);
                assertInSync(state, decodedState);
            });

            it("proxy `arr[i] = undefined` keeps today's path", () => {
                // $deleteAt records a DELETE and releases the refCount but never
                // touches `items`, so the cancel is deliberately not wired there —
                // `$onEncodeEnd` would resurrect the element with its ADD erased.
                // TODO: `$deleteAt` leaves encoder `items` holding X (pre-existing).
                const { state, decodedState } = bootstrapped("a", "b", "c");
                const warnings: string[] = [];
                const originalWarn = console.warn;
                console.warn = (...args: any[]) => warnings.push(String(args[0]));
                try {
                    state.list.push(item("X"));
                    (state.list as any)[3] = undefined;
                    decodedState.decode(state.encode());
                } finally {
                    console.warn = originalWarn;
                }
                assert.deepStrictEqual(warnings, []);
                assert.deepStrictEqual(names(decodedState.list), ["a", "b", "c"]);
                assertRefIdCounts(state, decodedState);
            });

            describe("StateView", () => {
                class Entity extends Schema {
                    @type("string") name = "";
                }
                class ViewState extends Schema {
                    @view() @type([Entity]) list = new ArraySchema<Entity>();
                }

                function trapWarnings(fn: () => void): string[] {
                    const warnings: string[] = [];
                    const originalWarn = console.warn, originalError = console.error;
                    console.warn = (...args: any[]) => warnings.push(String(args[0]));
                    console.error = (...args: any[]) => warnings.push(String(args[0]));
                    try { fn(); } finally { console.warn = originalWarn; console.error = originalError; }
                    return warnings;
                }

                it("push + view.add + pop in one tick", () => {
                    const state = new ViewState();
                    const encoder = getEncoder(state);
                    const client = createClientWithView(state);
                    client.view.add(state);
                    const a = Object.assign(new Entity(), { name: "a" });
                    state.list.push(a);
                    client.view.add(a);
                    encodeMultiple(encoder, state, [client]);
                    assert.deepStrictEqual(client.state.list.map((e) => e.name), ["a"]);

                    const warnings = trapWarnings(() => {
                        const e = Object.assign(new Entity(), { name: "e" });
                        state.list.push(e);
                        client.view.add(e);
                        state.list.pop();
                        encodeMultiple(encoder, state, [client]);
                    });
                    assert.deepStrictEqual(warnings, []);
                    assert.deepStrictEqual(client.state.list.map((e) => e.name), ["a"]);
                    assertNoOrphanRefs(state, client.state);
                });

                it("push + pop + view.remove in one tick", () => {
                    const state = new ViewState();
                    const encoder = getEncoder(state);
                    const client = createClientWithView(state);
                    client.view.add(state);
                    const a = Object.assign(new Entity(), { name: "a" });
                    state.list.push(a);
                    client.view.add(a);
                    encodeMultiple(encoder, state, [client]);

                    const warnings = trapWarnings(() => {
                        const e = Object.assign(new Entity(), { name: "e" });
                        state.list.push(e);
                        state.list.pop();
                        client.view.remove(e);
                        encodeMultiple(encoder, state, [client]);
                    });
                    assert.deepStrictEqual(warnings, []);
                    assert.deepStrictEqual(client.state.list.map((e) => e.name), ["a"]);
                    assertNoOrphanRefs(state, client.state);
                });

                /** Client bootstrapped with `list = names`, only `visible` added to its view. */
                function viewClient(names: string[], visible: string[]) {
                    const state = new ViewState();
                    const encoder = getEncoder(state);
                    const client = createClientWithView(state);
                    client.view.add(state);
                    for (const name of names) {
                        const e = Object.assign(new Entity(), { name });
                        state.list.push(e);
                        if (visible.includes(name)) { client.view.add(e); }
                    }
                    encodeMultiple(encoder, state, [client]);
                    return { state, encoder, client };
                }

                it("unshift + view.add + shift: the neighbour inheriting the slot stays hidden", () => {
                    // `e`'s parent edge still names slot 0, which hidden `a` now holds
                    const { state, encoder, client } = viewClient(["a", "b"], ["b"]);

                    const warnings = trapWarnings(() => {
                        const e = Object.assign(new Entity(), { name: "e" });
                        state.list.unshift(e);
                        client.view.add(e);
                        state.list.shift();
                        encodeMultiple(encoder, state, [client]);
                    });
                    assert.deepStrictEqual(warnings, []);
                    assert.deepStrictEqual(client.state.list.map((e) => e.name), ["b"]);
                    assertNoOrphanRefs(state, client.state);
                });

                it("unshift two + view.add + shift: the survivor is re-addressed to its new slot", () => {
                    // `e2` moves from slot 1 to 0; a stale index would send hidden `a` instead
                    const { state, encoder, client } = viewClient(["a", "b"], []);

                    const warnings = trapWarnings(() => {
                        const e1 = Object.assign(new Entity(), { name: "e1" });
                        const e2 = Object.assign(new Entity(), { name: "e2" });
                        state.list.unshift(e1, e2);
                        client.view.add(e1);
                        client.view.add(e2);
                        state.list.shift();
                        encodeMultiple(encoder, state, [client]);
                    });
                    assert.deepStrictEqual(warnings, []);
                    assert.deepStrictEqual(client.state.list.map((e) => e.name), ["e2"]);
                    assertNoOrphanRefs(state, client.state);
                });
            });
        });

        describe("instance aliased into a Schema field while its array slot is cancelled", () => {
            // Real-world shape (reported from a game server): a path of Points is
            // pushed into `moves`, and each movement step aliases `moves[0]` into
            // `targetMove` and shifts it out — many steps per encode window. The
            // array's ADD for the aliased Point never reaches the client, its slot
            // does, and the field's later DELETE_AND_ADD then removeRef's an already
            // collected refId. The client warns on every tick after, and its `moves`
            // is silently off by one before that. Fires on the Schema *field* op
            // (`decodeSchemaOperation`), which is the stack users actually see.
            class Point extends Schema {
                @type("number") x = 0;
                @type("number") y = 0;
            }
            class Player extends Schema {
                @type("number") speed = 1;
                @type([Point]) moves = new ArraySchema<Point>();
                @type(Point) targetMove = new Point();
                @type(Point) pos = new Point();
            }
            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
            }

            // The bug needs the Player tree enqueued BEFORE the path is pushed, so the
            // field op that introduces the aliased Point decodes ahead of the array's
            // phantom delete (the other way round the delete names an unknown refId
            // and is ignored). The real handler guarantees that order by reassigning
            // `moves` first; a scalar write is the minimal form of the same condition.
            const orderings: Array<[string, (p: Player) => void]> = [
                ["moves reassigned first (the real handler)", (p) => { p.moves = new ArraySchema<Point>(); }],
                ["scalar Player field written first", (p) => { p.speed = 2; }],
            ];

            for (const [ordering, dirtyPlayer] of orderings) {
                for (const stepsPerPatch of [1, 20]) {
                    it(`${ordering}, ${stepsPerPatch} step(s) per patch`, () => {
                        const state = new State();
                        getEncoder(state);
                        const decodedState = createInstanceFromReflection(state);
                        const player = new Player();
                        state.players.set("p1", player);
                        decodedState.decode(state.encode());

                        dirtyPlayer(player);
                        for (let i = 2; i <= 30; i++) {
                            player.moves.push(Object.assign(new Point(), { x: i, y: i }));
                        }

                        const warnings: string[] = [];
                        const originalWarn = console.warn;
                        console.warn = (...args: any[]) => warnings.push(String(args[0]));
                        try {
                            let patches = 0;
                            while (player.moves.length > 0 && patches < 40) {
                                for (let s = 0; s < stepsPerPatch && player.moves.length > 0; s++) {
                                    const move = player.moves[0];
                                    player.targetMove = move; // alias: two parents
                                    player.pos.x = move.x;
                                    player.pos.y = move.y;
                                    player.moves.shift(); // consumed inside the same patch window
                                }
                                decodedState.decode(state.encode());
                                patches++;

                                // Index skew is the primary symptom: it appears a full patch
                                // before the warning, and an app that never aliases a second
                                // instance would desync silently and never log at all.
                                const decodedPlayer = decodedState.players.get("p1")!;
                                assert.deepStrictEqual(
                                    decodedPlayer.moves.map((p) => p.x),
                                    player.moves.map((p) => p.x),
                                    `moves misaligned after patch ${patches}`,
                                );
                                assert.strictEqual(decodedPlayer.targetMove.x, player.targetMove.x);
                                assert.deepStrictEqual(warnings, [], `decoder warned during patch ${patches}`);
                                assertRefIdCounts(state, decodedState);
                                assertNoOrphanRefs(state, decodedState);
                            }
                        } finally {
                            console.warn = originalWarn;
                        }
                    });
                }
            }
        });
    });
});
