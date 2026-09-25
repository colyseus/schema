import * as assert from "assert";
import {
    Schema, type, view, schema, t, ArraySchema, MapSchema, SetSchema, CollectionSchema, StreamSchema, StateView,
    createPool, $changes, $refId,
} from "../src";
import type { KeyedRecorder } from "../src/encoder/KeyedRecorder";
import {
    createClientWithView, createInstanceFromReflection, encodeAllForView, encodeMultiple,
    getDecoder, getEncoder,
} from "./Schema";

class Item extends Schema {
    @type("number") v: number = 0;
}
class FilteredState extends Schema {
    @view() @type({ map: Item }) items = new MapSchema<Item>();
}
class PlainState extends Schema {
    @type({ map: Item }) items = new MapSchema<Item>();
    @type({ map: "number" }) nums = new MapSchema<number>();
}

const keysOf = (map: MapSchema<any>) => Array.from(map.keys());
const indexOf = (map: MapSchema<any>, key: string) => map.indexByKey.get(key);
const recOf = (map: MapSchema<any>) => (map as any)[$changes]?.rec as KeyedRecorder | undefined;

/** Both index tables describe exactly the live entries. */
function assertIndexTablesAgree(map: MapSchema<any>, label = "") {
    for (const key of map.keys()) {
        assert.strictEqual(map.keyByIndex.get(map.indexByKey.get(key)!), key, `${label} key ${key}`);
    }
    map.keyByIndex.forEach((key, index) => {
        assert.ok(map.has(key) && map.indexByKey.get(key) === index, `${label} stale keyByIndex[${index}] = ${key}`);
    });
}

/** Resync (reconnect) flow: full snapshot applied over existing client state. */
function resync<T extends Schema>(state: T, client: T) {
    getDecoder(client).decodeResync(getEncoder(state).encodeAll());
}

describe("MapSchema wire-index recycling", () => {

    describe("churn", () => {
        const churnCycles = (map: "items" | "nums", cycles: number) => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            const n = 100, churn = 10;
            let counter = 0;
            const nextKey = () => "k" + String(counter++).padStart(6, "0");
            const put = (key: string, j: number) => (map === "items")
                ? state.items.set(key, new Item().assign({ v: j }))
                : state.nums.set(key, j);
            const live: string[] = [];
            for (let j = 0; j < n; j++) { const k = nextKey(); live.push(k); put(k, j % churn); }
            client.decode(state.encode());

            const bytes: number[] = [];
            let maxIndex = 0;
            for (let c = 0; c < cycles; c++) {
                for (let j = 0; j < churn; j++) state[map].delete(live.shift()!);
                const deletes = state.encode();
                client.decode(deletes);
                for (let j = 0; j < churn; j++) {
                    const k = nextKey();
                    live.push(k);
                    put(k, j);
                    maxIndex = Math.max(maxIndex, indexOf(state[map], k)!);
                }
                const patch = state.encode();
                client.decode(patch);
                bytes.push(deletes.byteLength + patch.byteLength);
            }
            return { state, client, bytes, maxIndex, n, churn };
        };

        it("10 000 cycles: nextIndex stays within live + churn and headers stay small", () => {
            const { state, client, bytes, maxIndex, n, churn } = churnCycles("nums", 10_000);
            assert.ok(state.nums.nextIndex <= n + churn, `nextIndex ${state.nums.nextIndex}`);
            assert.ok(maxIndex < n + churn);
            // without recycling the late cycles address indexes > 8 192 (3-byte headers)
            const early = Math.max(...bytes.slice(0, 100));
            const late = Math.max(...bytes.slice(-1000));
            assert.ok(late <= early, `late ${late} > early ${early}`);
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assert.ok(client.nums.keyByIndex.size <= n + churn);
            assertIndexTablesAgree(client.nums, "client");
            assertIndexTablesAgree(state.nums, "server");
        });

        it("10 000 cycles of ref entries: the decoded state and refs match the server", () => {
            const { state, client, n, churn } = churnCycles("items", 10_000);
            assert.ok(state.items.nextIndex <= n + churn, `nextIndex ${state.items.nextIndex}`);
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assertIndexTablesAgree(client.items, "client");
            assert.strictEqual(getDecoder(client).root.refs.size, getEncoder(state).root.changeTrees.size);
        });
    });

    describe("same tick", () => {
        it("a re-set key keeps its index; a new key never gets an index freed this tick", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            state.nums.set("a", 1);
            state.nums.set("b", 2);
            client.decode(state.encode());

            state.nums.delete("a");
            state.nums.set("a", 10);
            assert.strictEqual(indexOf(state.nums, "a"), 0);
            state.nums.delete("b");
            state.nums.set("c", 3);
            assert.strictEqual(indexOf(state.nums, "c"), 2, "index 1 was freed this tick");
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());

            state.nums.set("d", 4);
            assert.strictEqual(indexOf(state.nums, "d"), 1, "reused from the next tick on");
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assertIndexTablesAgree(client.nums);
        });
    });

    describe("live walk order", () => {
        it("view bootstrap delivers entries in the server's $items order", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            for (const k of ["a", "b", "c"]) state.items.set(k, new Item().assign({ v: 1 }));
            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);

            // same-tick delete + re-set: "a" keeps index 0 but moves to the end of $items
            state.items.delete("a");
            state.items.set("a", new Item().assign({ v: 2 }));
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(state.items), ["b", "c", "a"]);

            client.view.add(state.items);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["b", "c", "a"]);
            assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

            const late = createClientWithView(state, client.view);
            encodeAllForView(encoder, late);
            assert.deepStrictEqual(keysOf(late.state.items), ["b", "c", "a"]);
        });

        it("after reuse, view bootstrap, encodeAllView and restage follow $items order", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            for (const k of ["a", "b", "c"]) state.items.set(k, new Item().assign({ v: 1 }));
            const client = createClientWithView(state);
            encodeMultiple(encoder, state, [client]);
            state.items.delete("a");
            encodeMultiple(encoder, state, [client]);
            state.items.set("d", new Item().assign({ v: 4 }));
            assert.strictEqual(indexOf(state.items, "d"), 0, "reused");
            encodeMultiple(encoder, state, [client]);

            client.view.add(state.items);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["b", "c", "d"]);

            const late = createClientWithView(state, client.view);
            encodeAllForView(encoder, late);
            assert.deepStrictEqual(keysOf(late.state.items), ["b", "c", "d"]);

            // restage: detach the map, re-attach it
            const plain = new PlainState();
            const plainClient = createInstanceFromReflection(plain);
            for (const k of ["a", "b", "c"]) plain.items.set(k, new Item().assign({ v: 1 }));
            plainClient.decode(plain.encode());
            plain.items.delete("a");
            plainClient.decode(plain.encode());
            plain.items.set("d", new Item().assign({ v: 4 }));
            plainClient.decode(plain.encode());
            assert.strictEqual(indexOf(plain.items, "d"), 0);
            const items = plain.items;
            plain.items = new MapSchema<Item>();
            plainClient.decode(plain.encode());
            plain.items = items;
            plainClient.decode(plain.encode());
            assert.deepStrictEqual(keysOf(plainClient.items), ["b", "c", "d"]);
            assert.deepStrictEqual(plainClient.toJSON(), plain.toJSON());
        });
    });

    describe("Root.pendingViewChanges", () => {
        it("lists the views not drained this tick, once per encodeEpoch", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item());
            const drained = createClientWithView(state);
            const skipped = createClientWithView(state);
            drained.view.add(state.items.get("a")!);
            skipped.view.add(state.items.get("a")!);

            encodeMultiple(encoder, state, [drained]);
            const root = encoder.root;
            const pending = root.pendingViewChanges();
            assert.deepStrictEqual(pending, [skipped.view.changes]);

            skipped.view.changes.clear();
            assert.strictEqual(root.pendingViewChanges(), pending, "cached within the epoch");
            assert.strictEqual(pending.length, 1);
            encoder.discardChanges();
            assert.deepStrictEqual(root.pendingViewChanges(), []);
        });

        it("relists a view written after it was found drained; dispose unlists it", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item());
            state.items.set("b", new Item());
            const client = createClientWithView(state);
            client.view.add(state.items.get("a")!);
            encodeMultiple(encoder, state, [client]);
            const root = encoder.root;
            assert.deepStrictEqual(root.pendingViewChanges(), []);
            assert.deepStrictEqual(root.viewsWithChanges, []);

            client.view.add(state.items.get("b")!);
            encoder.discardChanges();
            assert.deepStrictEqual(root.pendingViewChanges(), [client.view.changes]);
            client.view.dispose();
            assert.deepStrictEqual(root.viewsWithChanges, []);
        });

        it("view.remove binds an unbound view", () => {
            const state = new FilteredState();
            getEncoder(state);
            state.items.set("a", new Item());
            const view = new StateView();
            view.remove(state.items.get("a")!);
            assert.notStrictEqual(view.id, -1);
        });
    });

    describe("StateView", () => {
        it("view.add / view.remove of a child removed in an earlier tick write nothing on the map", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            state.items.set("b", new Item().assign({ v: 2 }));
            const client = createClientWithView(state);
            const a = state.items.get("a")!;
            client.view.add(a);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["a"]);

            state.items.delete("a");
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);

            const refId = state.items[$refId];
            client.view.remove(a);
            assert.strictEqual(client.view.changes.get(refId)?.has(0) ?? false, false);
            client.view.add(a);
            assert.strictEqual(client.view.changes.get(refId)?.has(0) ?? false, false);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);
        });

        it("view.remove of a child replaced this tick still deletes it", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            const client = createClientWithView(state);
            const a1 = state.items.get("a")!;
            client.view.add(a1);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), ["a"]);

            state.items.set("a", new Item().assign({ v: 2 })); // not visible to the view
            client.view.remove(a1);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(keysOf(client.state.items), []);
        });

        for (const pending of ["DELETE (view.remove)", "ADD (view.add)"]) {
            it(`an index a skipped view holds a ${pending} entry for is not reused until it drains`, () => {
                const state = new FilteredState();
                const encoder = getEncoder(state);
                state.items.set("a", new Item().assign({ v: 1 }));
                state.items.set("b", new Item().assign({ v: 2 }));
                const v = createClientWithView(state);
                const w = createClientWithView(state);
                const a = state.items.get("a")!;
                if (pending.startsWith("DELETE")) v.view.add(a);
                w.view.add(state.items);
                encodeMultiple(encoder, state, [v, w]);

                // tick T: V queues an entry for index 0, "a" goes away, V is skipped
                if (pending.startsWith("DELETE")) v.view.remove(a);
                else v.view.add(a);
                state.items.delete("a");
                encodeMultiple(encoder, state, [w]);
                assert.deepStrictEqual(recOf(state.items)!.quarantine, [0]);

                // T+1: a new key must not take index 0 while V still addresses it
                state.items.set("x", new Item().assign({ v: 3 }));
                assert.notStrictEqual(indexOf(state.items, "x"), 0);
                w.view.add(state.items.get("x")!);
                encodeMultiple(encoder, state, [v, w]);
                assert.deepStrictEqual(keysOf(v.state.items), []);
                assert.deepStrictEqual(keysOf(w.state.items), ["b", "x"]);
                assert.deepStrictEqual(recOf(state.items)!.free, [0], "released once V drained");

                // T+2: reused; V never sees the new occupant
                state.items.set("y", new Item().assign({ v: 4 }));
                assert.strictEqual(indexOf(state.items, "y"), 0);
                w.view.add(state.items.get("y")!);
                encodeMultiple(encoder, state, [v, w]);
                assert.deepStrictEqual(keysOf(v.state.items), []);
                assert.deepStrictEqual(keysOf(w.state.items), ["b", "x", "y"]);
            });
        }

        it("after reuse, view.add / view.remove of the removed child emit nothing", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            const v = createClientWithView(state);
            const a = state.items.get("a")!;
            v.view.add(a);
            encodeMultiple(encoder, state, [v]);
            state.items.delete("a");
            encodeMultiple(encoder, state, [v]);

            state.items.set("x", new Item().assign({ v: 2 }));
            assert.strictEqual(indexOf(state.items, "x"), 0);
            encodeMultiple(encoder, state, [v]);

            v.view.add(a); // stale: must not ship "x"
            encodeMultiple(encoder, state, [v]);
            assert.deepStrictEqual(keysOf(v.state.items), []);

            v.view.add(state.items.get("x")!);
            encodeMultiple(encoder, state, [v]);
            v.view.remove(a); // stale: must not delete "x"
            encodeMultiple(encoder, state, [v]);
            assert.deepStrictEqual(keysOf(v.state.items), ["x"]);
            assert.deepStrictEqual(v.state.toJSON(), state.toJSON());
        });

        it("a filtered map: view A saw the old occupant of an index, view B sees the new one", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item().assign({ v: 1 }));
            const A = createClientWithView(state);
            const B = createClientWithView(state);
            A.view.add(state.items.get("a")!);
            encodeMultiple(encoder, state, [A, B]);
            state.items.delete("a");
            encodeMultiple(encoder, state, [A, B]);

            state.items.set("x", new Item().assign({ v: 2 }));
            assert.strictEqual(indexOf(state.items, "x"), 0);
            B.view.add(state.items.get("x")!);
            encodeMultiple(encoder, state, [A, B]);
            assert.deepStrictEqual(keysOf(A.state.items), []);
            assert.deepStrictEqual(keysOf(B.state.items), ["x"]);

            state.items.get("x")!.v = 3;
            state.items.delete("x");
            encodeMultiple(encoder, state, [A, B]);
            assert.deepStrictEqual(keysOf(B.state.items), []);
        });
    });

    describe("reconnect mid-churn", () => {
        const churn = (state: PlainState, c: number) => {
            // delete 3, then (next tick) add 3 fresh keys
            for (const k of keysOf(state.items).slice(0, 3)) state.items.delete(k);
            state.encode();
            for (let j = 0; j < 3; j++) state.items.set(`c${c}-${j}`, new Item().assign({ v: c }));
            state.encode();
        };
        const setup = () => {
            const state = new PlainState();
            for (let j = 0; j < 8; j++) state.items.set(`init-${j}`, new Item().assign({ v: j }));
            const client = createInstanceFromReflection(state);
            client.decode(state.encode());
            return { state, client };
        };

        it("resync leaves no ghosts and the client index tables agree", () => {
            const { state, client } = setup();
            for (let c = 0; c < 5; c++) churn(state, c); // client offline
            resync(state, client);
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assertIndexTablesAgree(client.items);

            // later patches address the reused indexes correctly
            for (let c = 5; c < 10; c++) {
                for (const k of keysOf(state.items).slice(0, 3)) state.items.delete(k);
                client.decode(state.encode());
                for (let j = 0; j < 3; j++) state.items.set(`c${c}-${j}`, new Item().assign({ v: c }));
                client.decode(state.encode());
            }
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assertIndexTablesAgree(client.items);
        });

        it("a plain additive full sync is no worse than today: every server entry is right, ghosts are the entries deleted offline", () => {
            const { state, client } = setup();
            const before = new Set(keysOf(state.items));
            for (let c = 0; c < 5; c++) churn(state, c);
            client.decode(getEncoder(state).encodeAll());
            for (const [k, item] of state.items) assert.strictEqual(client.items.get(k)?.v, item.v, k);
            for (const k of client.items.keys()) {
                assert.ok(state.items.has(k) || before.has(k), `unexpected ghost ${k}`);
            }
            // patches after the sync keep every server entry right
            for (const k of keysOf(state.items).slice(0, 3)) state.items.delete(k);
            client.decode(state.encode());
            state.items.set("after", new Item().assign({ v: 99 }));
            client.decode(state.encode());
            for (const [k, item] of state.items) assert.strictEqual(client.items.get(k)?.v, item.v, k);
        });

        it("a late joiner's encodeAll / encodeAllView is right at every phase of the cycle", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            for (let j = 0; j < 6; j++) state.items.set(`init-${j}`, new Item().assign({ v: j }));
            const observer = createClientWithView(state);
            observer.view.add(state.items);
            encodeMultiple(encoder, state, [observer]);

            const joiners: ReturnType<typeof createClientWithView<FilteredState>>[] = [];
            const join = () => {
                const view = new StateView();
                view.add(state.items);
                const c = createClientWithView(state, view);
                encodeAllForView(encoder, c);
                assert.deepStrictEqual(c.state.toJSON(), state.toJSON(), `joiner ${joiners.length}`);
                joiners.push(c);
            };
            const tick = () => {
                const all = [observer, ...joiners];
                encodeMultiple(encoder, state, all);
                for (const c of all) assert.deepStrictEqual(c.state.toJSON(), state.toJSON());
            };
            for (let c = 0; c < 4; c++) {
                for (const k of keysOf(state.items).slice(0, 2)) state.items.delete(k);
                join(); // mid-tick: deletes pending
                tick();
                join(); // between ticks: indexes free
                for (let j = 0; j < 2; j++) {
                    const item = new Item().assign({ v: c });
                    state.items.set(`c${c}-${j}`, item);
                    observer.view.add(item);
                    for (const joiner of joiners) joiner.view.add(item);
                }
                join(); // mid-tick: indexes reused
                tick();
            }
            assert.ok(state.items.nextIndex <= 8, `nextIndex ${state.items.nextIndex}`);
        });
    });

    describe("lifecycle", () => {
        const freeSome = () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            for (const k of ["a", "b", "c", "d"]) state.nums.set(k, 1);
            client.decode(state.encode());
            state.nums.delete("b");
            state.nums.delete("c");
            client.decode(state.encode());
            assert.deepStrictEqual(recOf(state.nums)!.free, [1, 2]);
            return { state, client };
        };
        const assertUniqueIndexes = (map: MapSchema<any>) => {
            const indexes = Array.from(map.indexByKey.values());
            assert.strictEqual(new Set(indexes).size, indexes.length, `duplicate index in ${indexes}`);
        };

        it("clear() drops the free indexes (tracked and untracked)", () => {
            for (const untracked of [false, true]) {
                const { state, client } = freeSome();
                if (untracked) state.nums.untracked(() => state.nums.clear());
                else state.nums.clear();
                assert.strictEqual(recOf(state.nums)!.free, undefined);
                for (const k of ["x", "y", "z"]) state.nums.set(k, 2);
                assert.deepStrictEqual(keysOf(state.nums).map((k) => indexOf(state.nums, k)), [0, 1, 2]);
                assertUniqueIndexes(state.nums);
                if (!untracked) {
                    client.decode(state.encode());
                    assert.deepStrictEqual(client.toJSON(), state.toJSON());
                }
            }
        });

        it("clear() drops the quarantine", () => {
            const state = new FilteredState();
            const encoder = getEncoder(state);
            state.items.set("a", new Item());
            const v = createClientWithView(state);
            const a = state.items.get("a")!;
            v.view.add(a);
            encodeMultiple(encoder, state, [v]);
            v.view.remove(a);
            state.items.delete("a");
            encodeMultiple(encoder, state, []);
            assert.deepStrictEqual(recOf(state.items)!.quarantine, [0]);
            state.items.clear();
            assert.strictEqual(recOf(state.items)!.quarantine, undefined);
        });

        it("a pooled $reset starts over with no free indexes", () => {
            class Entity extends Schema {
                @type({ map: "number" }) nums = new MapSchema<number>();
            }
            class State extends Schema {
                @type({ map: Entity }) entities = new MapSchema<Entity>();
            }
            const state = new State();
            getEncoder(state);
            const pool = createPool(Entity);
            const e = pool.acquire();
            state.entities.set("e", e);
            for (const k of ["a", "b", "c"]) e.nums.set(k, 1);
            state.encode();
            e.nums.delete("a");
            state.encode();
            assert.deepStrictEqual(recOf(e.nums)!.free, [0]);

            state.entities.delete("e");
            state.encode();
            pool.release(e);
            assert.strictEqual(recOf(e.nums)!.free, undefined);
            assert.strictEqual(e.nums.nextIndex, 0);
        });

        it("discardAllChanges / discard never free an index", () => {
            const state = new PlainState();
            const client = createInstanceFromReflection(state);
            for (const k of ["a", "b"]) state.nums.set(k, 1);
            client.decode(state.encode());
            state.nums.delete("a");
            state.discardAllChanges();
            assert.strictEqual(recOf(state.nums)!.free, undefined);
            state.nums.set("c", 1);
            assert.strictEqual(indexOf(state.nums, "c"), 2);
        });
    });

    describe("collections that never recycle", () => {
        it("a streamed map keeps monotonic indexes", () => {
            const Entity = schema({ id: t.number() }, "Entity");
            const State = schema({ entities: t.map(Entity).stream() }, "State");
            const state: any = new State();
            const encoder = getEncoder(state);
            const decoded: any = new State();
            decoded.decode(state.encodeAll());
            for (const k of ["a", "b"]) state.entities.set(k, new Entity().assign({ id: 1 }));
            decoded.decode(state.encode());
            state.entities.delete("a");
            decoded.decode(state.encode());
            decoded.decode(state.encode());
            state.entities.set("c", new Entity().assign({ id: 2 }));
            assert.strictEqual(state.entities.indexByKey.get("c"), 2);
            assert.strictEqual(recOf(state.entities)?.free, undefined);
            decoded.decode(state.encode());
            assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
            void encoder;
        });

        it("StreamSchema positions stay monotonic; Set / Collection reuse (test/SetIndexRecycling)", () => {
            class State extends Schema {
                @type({ set: "string" }) set = new SetSchema<string>();
                @type({ collection: "string" }) collection = new CollectionSchema<string>();
                @type({ stream: Item }) stream = new StreamSchema<Item>();
            }
            const state = new State();
            const client = createInstanceFromReflection(state);
            state.set.add("a");
            state.collection.add("a");
            const first = new Item();
            state.stream.add(first);
            client.decode(state.encode());
            state.set.delete("a");
            state.collection.delete("a");
            state.stream.remove(first);
            client.decode(state.encode());
            state.set.add("b");
            state.collection.add("b");
            state.stream.add(new Item());
            client.decode(state.encode());
            assert.strictEqual((state.set as any).nextIndex, 1);
            assert.strictEqual((state.collection as any).nextIndex, 1);
            assert.strictEqual((state.stream as any).$nextPosition, 2);
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
        });

        // Design §4: the decoder fix that Set / Collection / Stream index recycling needs.
        // Each case replays a fresh encoder whose refIds collide with the first one,
        // so its ADD@0 lands on the client's occupied index 0.
        it("a SetSchema ADD onto an occupied index replaces the entry", () => {
            class State extends Schema {
                @type({ set: "string" }) set = new SetSchema<string>();
            }
            const server1 = new State();
            server1.set.add("a");
            const client = createInstanceFromReflection(server1);
            client.decode(server1.encode());

            const server2 = new State();
            server2.set.add("b");
            client.decode(getEncoder(server2).encode());

            assert.deepStrictEqual(Array.from(client.set.values()), ["b"]);
            assert.strictEqual(client.set.has("a"), false, "the replaced value left the reverse index");
            assert.strictEqual(client.set.has("b"), true);
        });

        for (const [kind, make, add] of [
            ["SetSchema", () => new SetSchema<Item>(), (c: any, v: Item) => c.add(v)],
            ["CollectionSchema", () => new CollectionSchema<Item>(), (c: any, v: Item) => c.add(v)],
            ["StreamSchema", () => new StreamSchema<Item>(), (c: any, v: Item) => c.add(v)],
        ] as const) {
            it(`a ${kind} ADD of a Schema child onto an occupied index replaces it and releases the old one`, () => {
                const decl = kind === "SetSchema" ? { set: Item } : kind === "CollectionSchema" ? { collection: Item } : { stream: Item };
                class State extends Schema {
                    @type(decl as any) items = make();
                    @type([Item]) burn = new ArraySchema<Item>();
                }
                // attach first: a stream routes an element only once it has a Root
                const server1 = new State();
                const client = createInstanceFromReflection(server1);
                // use up refIds (pushed and cleared in one tick, so the client never
                // sees them): `first` gets a higher id than the replacement below
                for (let i = 0; i < 5; i++) server1.burn.push(new Item());
                server1.burn.clear();
                const first = new Item().assign({ v: 1 });
                add(server1.items, first);
                client.decode(server1.encode());
                const decoder = getDecoder(client);
                const firstRefId = first[$refId];
                assert.strictEqual(decoder.root.refCount.get(firstRefId), 1);

                // same class and field order: the fresh encoder hands out the same refIds
                // for the root and the collections, and an id the client does not know
                // for the replacement child, which lands on `first`'s index 0
                const server2 = new State();
                const encoder2 = getEncoder(server2);
                const second = new Item().assign({ v: 2 });
                add(server2.items, second);
                client.decode(encoder2.encode());

                const values = Array.from((client.items as any).values()) as Item[];
                assert.deepStrictEqual(values.map((v) => v.v), [2]);
                const byValue = (client.items as any).indexByValue ?? (client.items as any)._itemIndex;
                assert.strictEqual(byValue.has(values[0]), true);
                assert.strictEqual(byValue.size, 1, "the replaced child left the reverse index");
                assert.notStrictEqual(second[$refId], firstRefId);
                assert.strictEqual(values[0][$refId], second[$refId], "the client holds the replacement");
                assert.strictEqual(decoder.root.refCount.get(firstRefId) ?? 0, 0, "the replaced child was released");
            });
        }
    });
});
