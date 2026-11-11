import * as assert from "assert";

import { getCallbacks, getEncoder, createInstanceFromReflection, getDecoder, assertDeepStrictEqualEncodeAll, assertRefIdCounts, assertNoOrphanRefs, createClientWithView, encodeMultiple, encodeAndAssertEquals } from "./Schema";
import { ArraySchema, MapSchema, Schema, type, view, $changes, $refId, enableLegacyCompat } from "../src";
import { getAllParents } from "../src/encoder/changeTree/parentChain";

// Type side of the opt-in. It applies to every file of this tsconfig; the
// default read-only typing is checked in test/types/ArrayIndexReadonly.ts.
declare module "../src/types/custom/ArraySchema" {
    interface ArraySchemaOptions { legacyCompat: true }
}

/**
 * 5.x wrote arrays by index. `enableLegacyCompat()` brings that back:
 * every case here is a 5.x test that 6.0 had rewritten to `set()` /
 * `splice()` or dropped, running again as it was written.
 */
describe("ArraySchema 5.x behaviour (enableLegacyCompat)", () => {
    before(() => enableLegacyCompat());
    after(() => enableLegacyCompat(false));

    class Item extends Schema {
        @type("string") name: string;
    }
    class State extends Schema {
        @type(["number"]) numbers = new ArraySchema<number>();
        @type(["string"]) strings = new ArraySchema<string>();
        @type([Item]) items = new ArraySchema<Item>();
    }
    const item = (name: string) => new Item().assign({ name });
    const nameOf = (v: any) => (typeof v === "string") ? v : v.name;
    const byName = (a: any, b: any) => nameOf(a).localeCompare(nameOf(b));

    /** `items` and `strings` holding `initial`, already sent to a client. */
    function synced(initial: string[]) {
        const state = new State();
        const decodedState = createInstanceFromReflection(state);
        state.items.push(...initial.map(item));
        state.strings.push(...initial);
        decodedState.decode(state.encode());
        return { state, decodedState };
    }

    /** Runs `mutate` on a ref array and a primitive array in one tick; one patch must land both on `expected`. */
    function assertSameTick(
        initial: string[],
        mutate: (arr: ArraySchema<any>, wrap: (name: string) => any) => void,
        expected: string[],
    ) {
        const { state, decodedState } = synced(initial);
        mutate(state.items, item);
        mutate(state.strings, (name) => name);

        assert.deepStrictEqual(state.items.map(nameOf), expected, "server items");
        assert.deepStrictEqual([...state.strings], expected, "server strings");

        decodedState.decode(state.encode());
        assert.deepStrictEqual(decodedState.items.map(nameOf), expected, "decoded items");
        assert.deepStrictEqual([...decodedState.strings], expected, "decoded strings");
        assertRefIdCounts(state, decodedState);
        assertDeepStrictEqualEncodeAll(state);
    }

    describe("what the mode wraps", () => {
        it("a wrapped array is still an ArraySchema and an Array", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            assert.ok(arr instanceof ArraySchema);
            assert.ok(Array.isArray(arr));
            assert.strictEqual(arr.constructor, ArraySchema);
            assert.deepStrictEqual([...arr], [1, 2, 3]);
            assert.deepStrictEqual(JSON.parse(JSON.stringify(arr)), [1, 2, 3]);
        });

        it("ArraySchema.from(), ArraySchema.of(), clone() and a plain array assigned to a field are tracked", () => {
            const state = new State();
            const decodedState = createInstanceFromReflection(state);

            state.numbers = ArraySchema.from([1, 2, 3]);
            state.numbers[0] = 10;
            encodeAndAssertEquals(state, decodedState);

            state.numbers = ArraySchema.of(4, 5);
            state.numbers[1] = 50;
            encodeAndAssertEquals(state, decodedState);

            state.numbers = state.numbers.clone();
            state.numbers[0] = 40;
            encodeAndAssertEquals(state, decodedState);

            state.numbers = [7, 8, 9] as any;
            state.numbers[2] = 90;
            encodeAndAssertEquals(state, decodedState);

            assert.deepStrictEqual(decodedState.numbers.toJSON(), [7, 8, 90]);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("methods that return the array return the tracked one", () => {
            const { state, decodedState } = synced(["c", "a", "b"]);
            assert.strictEqual(state.strings.sort(), state.strings);
            assert.strictEqual(state.strings.reverse(), state.strings);

            state.strings.sort()[0] = "A";
            state.strings.set(1, "B")[2] = "C";
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.strings.toJSON(), ["A", "B", "C"]);
        });

        it("the array handed to a callback is the tracked one", () => {
            const state = new State();
            state.numbers.push(1, 2, 3);
            const decoded = createInstanceFromReflection(state);
            decoded.decode(state.encodeAll());

            state.numbers.forEach((v, i, arr) => { arr[i] = v * 10; });
            decoded.decode(state.encode());
            assert.deepStrictEqual(decoded.numbers.toArray(), [10, 20, 30]);

            state.numbers.reduce((sum, v, i, arr) => { arr[i] = sum + v; return sum + v; }, 0);
            decoded.decode(state.encode());
            assert.deepStrictEqual(decoded.numbers.toArray(), [10, 30, 60]);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("decoded arrays are plain: nothing is wrapped on the client", () => {
            const { decodedState } = synced(["a", "b"]);
            const strings: any = decodedState.strings;
            strings[0] = "local";
            assert.strictEqual(strings[0], "local");
            strings.length = 5; // a native write: a wrapped array would refuse to grow
            assert.strictEqual(strings.length, 5);
        });

        it("an array built before the mode was turned on stays untracked by index", () => {
            enableLegacyCompat(false);
            const state = new State();
            enableLegacyCompat();
            const decodedState = createInstanceFromReflection(state);
            state.numbers.push(1, 2);
            decodedState.decode(state.encode());

            (state.numbers as any)[0] = 9;
            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.numbers.toJSON(), [1, 2]);
        });

        it("`delete arr[i]` leaves the element, as in 5.x", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            delete (state.strings as any)[1];
            assert.deepStrictEqual([...state.strings], ["a", "b", "c"]);
            assert.strictEqual(getEncoder(state).hasChanges, false);
            encodeAndAssertEquals(state, decodedState);
        });
    });

    describe("reading and writing by key (5.0.46, #255)", () => {
        // encoder side is wrapped; decoder side is a plain instance
        function createArrays() {
            const state = new State();
            state.numbers.push(10, 20, 30);
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());
            return [
                { side: "encoder", numbers: state.numbers as any },
                { side: "decoder", numbers: decodedState.numbers as any },
            ];
        }

        it("reads elements by number and by index string", () => {
            for (const { side, numbers } of createArrays()) {
                assert.strictEqual(numbers[0], 10, side);
                assert.strictEqual(numbers[2], 30, side);
                assert.strictEqual(numbers["0"], 10, side);
                assert.strictEqual(numbers["2"], 30, side);
                assert.strictEqual(numbers[3], undefined, side);
                assert.strictEqual(numbers["3"], undefined, side);
            }
        });

        it("reads properties and methods by name", () => {
            for (const { side, numbers } of createArrays()) {
                assert.strictEqual(numbers.length, 3, side);
                assert.strictEqual(numbers["length"], 3, side);
                assert.strictEqual(numbers.at(-1), 30, side);
                assert.strictEqual(numbers.find((value: number) => value > 10), 20, side);
                assert.strictEqual(numbers.includes(20), true, side);
                assert.deepStrictEqual(numbers.map((value: number) => value / 10), [1, 2, 3], side);
                assert.deepStrictEqual(numbers.toJSON(), [10, 20, 30], side);
                assert.deepStrictEqual([...numbers], [10, 20, 30], side);
                assert.strictEqual(numbers.constructor, ArraySchema, side);
                assert.strictEqual(numbers.unknownProperty, undefined, side);
            }
        });

        it("reads names that start with a symbol character", () => {
            for (const { side, numbers } of createArrays()) {
                assert.strictEqual(typeof numbers["$pushAll"], "function", side);
                assert.strictEqual(numbers["$unknown"], undefined, side);
            }
        });

        it("number-like keys that are not an index read as undefined", () => {
            const keys = [
                "Infinity", "+Infinity", "-Infinity", "NaN",
                "", " ", " 1", "1 ", " 1", "﻿1",
                "-1", "+1", "1.5", ".5", "01", "1e0", "0x1", "0b1",
            ];
            for (const { side, numbers } of createArrays()) {
                for (const key of keys) {
                    assert.strictEqual(numbers[key], undefined, `${side}: ${JSON.stringify(key)}`);
                }
                assert.strictEqual(numbers[-1], undefined, side);
                assert.strictEqual(numbers[1.5], undefined, side);
                assert.strictEqual(numbers[Infinity], undefined, side);
                assert.strictEqual(numbers[NaN], undefined, side);
            }
        });

        // all but the last pass isNaN(), yet none is a canonical index
        const NON_INDEX_KEYS = [
            "Infinity", " 1", "﻿1", "", " 1", "+1", "-1", "01", "1e0", "1.5",
            "customProperty",
        ];

        it("a key that is not an index is a plain property for set, get and `in`", () => {
            for (const key of NON_INDEX_KEYS) {
                for (const { side, numbers } of createArrays()) {
                    const message = `${side}: ${JSON.stringify(key)}`;
                    assert.strictEqual(key in numbers, false, message);

                    numbers[key] = 7;

                    assert.strictEqual(numbers[key], 7, message);
                    assert.strictEqual(key in numbers, true, message);
                    assert.strictEqual(numbers.length, 3, message);
                    assert.deepStrictEqual(numbers.toJSON(), [10, 20, 30], message);
                }
            }
        });

        it("writing a key that is not an index sends nothing to clients", () => {
            for (const key of NON_INDEX_KEYS) {
                const state = new State();
                state.numbers.push(10, 20, 30);
                const encoder = getEncoder(state);
                const decodedState = createInstanceFromReflection(state);
                decodedState.decode(state.encode());

                (state.numbers as any)[key] = 7;

                assert.strictEqual(encoder.hasChanges, false, JSON.stringify(key));
                decodedState.decode(state.encode());
                assert.deepStrictEqual(decodedState.numbers.toJSON(), [10, 20, 30], JSON.stringify(key));
            }
        });

        it("nulling an index past the end sends nothing to clients", () => {
            const state = new State();
            state.numbers.push(10, 20, 30);
            const encoder = getEncoder(state);
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            (state.numbers as any)[3] = null;
            (state.numbers as any)[10] = undefined;

            assert.strictEqual(encoder.hasChanges, false);
            assert.deepStrictEqual(state.numbers.toJSON(), [10, 20, 30]);
        });

        it("arr[-1] after shift() in the same patch stays in sync", () => {
            const state = new State();
            state.numbers.push(1, 2, 3);
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            state.numbers.shift();
            (state.numbers as any)[-1] = 9;

            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.numbers.toJSON(), [2, 3]);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("index writes and `in` still address the elements", () => {
            const state = new State();
            state.numbers.push(10, 20, 30);
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            state.numbers[1] = 21;
            (state.numbers as any)["2"] = 31;

            assert.strictEqual(0 in state.numbers, true);
            assert.strictEqual("2" in state.numbers, true);
            assert.strictEqual(3 in state.numbers, false);
            assert.strictEqual("3" in state.numbers, false);
            assert.strictEqual("length" in state.numbers, true);

            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.numbers.toJSON(), [10, 21, 31]);

            state.numbers.length = 0;
            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.numbers.toJSON(), []);
        });
    });

    describe("`arr[i] = value`", () => {
        it("writing at the end of an empty array appends", () => {
            const state = new State();
            const decodedState = new State();
            const $ = getCallbacks(decodedState);

            state.strings[0] = "one";
            state.strings[1] = "two";
            state.strings[2] = "three";

            const added: Array<{ item: string, index: number }> = [];
            $(decodedState).strings.onAdd((item, index) => added.push({ item, index }));
            decodedState.decode(state.encode());

            assert.deepStrictEqual([...state.strings], ["one", "two", "three"]);
            assert.deepStrictEqual(added, [
                { item: "one", index: 0 },
                { item: "two", index: 1 },
                { item: "three", index: 2 },
            ]);
        });

        it("writing index 0 of an array assigned in the same tick", () => {
            class Current extends Schema {
                @type(["number"]) current: ArraySchema<number>;
            }
            const state = new Current();
            const decodedState = new Current();

            state.current = new ArraySchema<number>();
            state.current[0] = 0;

            decodedState.decode(state.encode());
            assert.strictEqual(0, decodedState.current[0]);
        });

        it("replaces a primitive element, one patch per write", () => {
            const state = new State();
            const decodedState = createInstanceFromReflection(state);
            state.numbers.push(1, 2, 3);
            decodedState.decode(state.encode());

            for (let i = 0; i < 3; i++) {
                state.numbers[i] = -(i + 1);
                decodedState.decode(state.encode());
                assert.strictEqual(3, decodedState.numbers.length);
            }

            assert.deepStrictEqual(decodedState.numbers.toJSON(), [-1, -2, -3]);
            assertRefIdCounts(state, decodedState);
        });

        it("replaces a Schema element, one patch per write", () => {
            const state = new State();
            const decodedState = createInstanceFromReflection(state);
            state.items.push(item("a"), item("b"), item("c"));
            decodedState.decode(state.encode());

            for (let i = 0; i < 3; i++) {
                state.items[i] = item("new" + i);
                decodedState.decode(state.encode());
                assert.strictEqual(3, decodedState.items.length);
            }

            assert.deepStrictEqual(decodedState.items.map(nameOf), ["new0", "new1", "new2"]);
            assertRefIdCounts(state, decodedState);
        });

        it("replacing a Schema element releases the old instance", () => {
            const state = new State();
            const encoder = getEncoder(state);
            const decodedState = new State();

            const first = item("first");
            state.items.push(first);
            decodedState.decode(state.encode());

            const second = item("second");
            state.items[0] = second;
            decodedState.decode(state.encode());
            assertRefIdCounts(state, decodedState);

            assert.strictEqual(1, encoder.root.refCount.get(second[$refId]));
            assert.strictEqual(undefined, encoder.root.refCount.get(first[$refId]));
        });

        it("writing the value already there sends nothing", () => {
            const state = new State();
            state.numbers[0] = 1;
            state.numbers[1] = 2;
            state.numbers[2] = 3;
            assert.ok(state.encode().length > 0);

            state.numbers[0] = 1;
            state.numbers[1] = 2;
            state.numbers[2] = 3;
            assert.ok(state.encode().length === 0);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("the assignment expression yields the assigned value", () => {
            class Player extends Schema {
                @type(["string"]) itemIds = new ArraySchema<string>();
            }
            class Game extends Schema {
                @type(Player) player = new Player();
            }
            const state = new Game();
            const decodedState = new Game();
            state.player.itemIds.push("Item 1", "Item 2", "Item 3", "Item 4", "Item 5");
            decodedState.decode(state.encodeAll());

            state.player.itemIds.splice(1, 1);
            decodedState.decode(state.encode());

            const preEncoding = state.player.itemIds[1] = "Item 3 changed!";
            decodedState.decode(state.encode());

            assert.strictEqual(4, decodedState.player.itemIds.length);
            assert.strictEqual(decodedState.player.itemIds[1], preEncoding);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("`arr[i]++` on every element", () => {
            const state = new State();
            for (let i = 0; i < 10; i++) state.numbers.push(i);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            client.decode(state.encode());

            for (let j = 0; j < state.numbers.length; j++) state.numbers[j]++;
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        });

        it("writing past the end appends: the array never holds a hole", () => {
            const state = new State();
            const decodedState = new State();
            decodedState.decode(state.encodeAll());

            state.items[0] = item("Sparse 0");
            state.items[2] = item("Sparse 2");
            state.items[4] = item("Sparse 4");

            assert.doesNotThrow(() => decodedState.decode(state.encode()));
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["Sparse 0", "Sparse 2", "Sparse 4"]);
        });

        it("300 index writes in one patch", () => {
            const state = new State();
            for (let i = 0; i < 300; i++) state.numbers.push(0);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            client.decode(state.encode());

            for (let i = 0; i < 300; i++) state.numbers[i] = i + 1;
            client.decode(state.encode());
            assert.deepStrictEqual(client.toJSON(), state.toJSON());
            assertRefIdCounts(state, client);
        });

        it("random index writes mixed with push, splice and reverse", () => {
            let seed = 12345;
            const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
            const state = new State();
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            let n = 0;

            for (let tick = 0; tick < 200; tick++) {
                for (let step = 0; step < 4; step++) {
                    const r = rand();
                    const { numbers, items } = state;
                    if (r < 0.2) numbers.push(Math.floor(rand() * 100));
                    else if (r < 0.3 && numbers.length) numbers.splice(Math.floor(rand() * numbers.length), 1);
                    else if (r < 0.45 && numbers.length) numbers[Math.floor(rand() * numbers.length)] = Math.floor(rand() * 100);
                    else if (r < 0.6) items.push(item(`n${n++}`));
                    else if (r < 0.7 && items.length) items[Math.floor(rand() * items.length)] = item(`n${n++}`);
                    else if (r < 0.8 && items.length) items[Math.floor(rand() * items.length)] = null;
                    else if (r < 0.85 && items.length) items.reverse();
                    else if (r < 0.9 && items.length) items.length = Math.floor(rand() * items.length);
                    else if (items.length) items[0].name = `renamed${n++}`;
                }
                client.decode(state.encode());
                assert.deepStrictEqual(client.toJSON(), state.toJSON(), `tick ${tick}`);
            }
            assertRefIdCounts(state, client);
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("`arr[i] = null | undefined` removes the element on both sides (5.0.47, #254)", () => {
        const nextTick: Record<string, (arr: ArraySchema<any>, wrap: (name: string) => any) => void> = {
            "arr[1] = x": (arr, wrap) => { arr[1] = wrap("x"); },
            "push()": (arr, wrap) => { arr.push(wrap("x")); },
            "pop()": (arr) => { arr.pop(); },
            "shift()": (arr) => { arr.shift(); },
            "unshift()": (arr, wrap) => { arr.unshift(wrap("x")); },
        };

        for (const [label, op] of Object.entries(nextTick)) {
            it(`then ${label} next tick`, () => {
                for (const nullish of [null, undefined] as any[]) {
                    const { state, decodedState } = synced(["a", "b", "c"]);
                    (state.items as any)[1] = nullish;
                    (state.strings as any)[1] = nullish;
                    assert.deepStrictEqual(state.items.map(nameOf), ["a", "c"]);
                    assert.deepStrictEqual([...state.strings], ["a", "c"]);
                    encodeAndAssertEquals(state, decodedState);

                    op(state.items, item);
                    op(state.strings, (name) => name);
                    encodeAndAssertEquals(state, decodedState);
                    assertRefIdCounts(state, decodedState);
                    assertDeepStrictEqualEncodeAll(state);
                }
            });
        }

        it("child mutation after removal reaches the right element", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            (state.items as any)[1] = null;
            decodedState.decode(state.encode());

            state.items[1].name = "C";
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["a", "C"]);
        });

        it("cancels a push made in the same tick, without a warning", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            const warnings: string[] = [];
            const originalWarn = console.warn;
            console.warn = (...args: any[]) => warnings.push(String(args[0]));
            try {
                state.items.push(item("X"));
                (state.items as any)[3] = undefined;
                decodedState.decode(state.encode());
            } finally {
                console.warn = originalWarn;
            }
            assert.deepStrictEqual(warnings, []);
            assert.deepStrictEqual(state.items.map(nameOf), ["a", "b", "c"]);
            assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
            assertRefIdCounts(state, decodedState);
        });

        it("clearing then refilling every index in one tick", () => {
            const state = new State();
            for (let i = 0; i < 100; i++) state.numbers.push(i);
            const decodedState = new State();
            decodedState.decode(state.encode());

            // a removal shifts the rest down: the refill overwrites the next element, or appends
            for (let i = 0; i < 100; i++) {
                (state.numbers as any)[i] = undefined;
                state.numbers[i] = i * 100;
            }
            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.numbers.toJSON(), state.numbers.toJSON());
            assert.strictEqual(state.numbers.length, 100);
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("`arr.length = n`", () => {
        it(".length = 0", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            arr.length = 0;
            assert.deepStrictEqual([], arr.toJSON());
        });

        it(".length = x", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            arr.length = 3;
            assert.deepStrictEqual([1, 2, 3], arr.toJSON());
        });

        it("truncating reaches clients and releases the removed instances", () => {
            const { state, decodedState } = synced(["a", "b", "c", "d"]);
            state.items.length = 2;
            state.strings.length = 2;
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["a", "b"]);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);

            state.items.length = 0;
            state.strings.length = 0;
            encodeAndAssertEquals(state, decodedState);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a larger length is refused with a warning", () => {
            const { state, decodedState } = synced(["a", "b"]);
            const warnings: string[] = [];
            const originalWarn = console.warn;
            console.warn = (...args: any[]) => warnings.push(String(args[0]));
            try {
                state.strings.length = 5;
            } finally {
                console.warn = originalWarn;
            }
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(state.strings.length, 2);
            assert.strictEqual(getEncoder(state).hasChanges, false);
            encodeAndAssertEquals(state, decodedState);
        });

        for (const sameTick of [true, false]) {
            it(`re-adding an instance dropped by length = 0 (${sameTick ? "same tick as the add" : "after the add was sent"})`, () => {
                class Holder extends Schema {
                    @type({ map: Item }) other = new MapSchema<Item>();
                    @type([Item]) arr = new ArraySchema<Item>();
                }
                const state = new Holder();
                const encoder = getEncoder(state);
                const decoded = createInstanceFromReflection(state);
                decoded.decode(encoder.encodeAll());
                encoder.discardChanges();

                const shared = item("shared");
                state.arr.push(shared);
                if (!sameTick) {
                    decoded.decode(encoder.encode());
                    encoder.discardChanges();
                }
                state.arr.length = 0;
                decoded.decode(encoder.encode());
                encoder.discardChanges();

                state.other.set("k", shared);
                state.arr.push(shared);
                state.other.set("k", item("other"));
                decoded.decode(encoder.encode());

                assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
                assertRefIdCounts(state, decoded);
                assertNoOrphanRefs(state, decoded);
            });
        }
    });

    describe("in the same tick as another operation", () => {
        it("`arr[j]++` rounds interleaved with shift()", () => {
            const state = new State();
            for (let i = 0; i < 10; i++) state.numbers.push(i);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            client.decode(state.encode());

            for (let round = 0; round < 3; round++) {
                for (let j = 0; j < state.numbers.length; j++) state.numbers[j]++;
                state.numbers.shift();
            }
            client.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), client.toJSON());

            for (let round = 0; round < 2; round++) {
                for (let j = 0; j < state.numbers.length; j++) state.numbers[j]++;
                state.numbers.shift();
                state.numbers.push(100 + round);
            }
            client.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), client.toJSON());
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a client joining mid-churn agrees with one that saw every patch", () => {
            const mutateAllAndShift = (state: State, count: number) => {
                for (let i = 0; i < count; i++) {
                    for (let j = 0; j < state.numbers.length; j++) state.numbers[j]++;
                    state.numbers.shift();
                }
            };
            const state = new State();
            for (let i = 0; i < 35; i++) state.numbers.push(i);

            state.encode();
            const oldClient = createInstanceFromReflection(state);
            oldClient.decode(state.encodeAll());

            mutateAllAndShift(state, 6);
            oldClient.decode(state.encode());
            mutateAllAndShift(state, 9);
            oldClient.decode(state.encode());
            const freshClient = createInstanceFromReflection(state);
            freshClient.decode(state.encodeAll());

            mutateAllAndShift(state, 5);
            const patch = state.encode();
            oldClient.decode(patch);
            freshClient.decode(patch);

            assert.deepStrictEqual(oldClient.toJSON(), state.toJSON());
            assert.deepStrictEqual(freshClient.toJSON(), state.toJSON());
        });

        it("shift() then an index write of a new instance", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            state.items.shift();
            state.items[0] = item("z");
            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["z", "c"]);
            assertRefIdCounts(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("index write, push(), then unshift()", () => {
            const state = new State();
            state.numbers.push(1, 2, 3);
            const decodedState = new State();
            decodedState.decode(state.encode());

            state.numbers[2] = 99;
            state.numbers.push(4);
            state.numbers.unshift(0);

            decodedState.decode(state.encode());
            assert.deepStrictEqual([0, 1, 2, 99, 4], decodedState.numbers.toJSON());
            assertDeepStrictEqualEncodeAll(state);
        });

        it("index write between unshift(), splice() and push()", () => {
            const state = new State();
            for (let i = 0; i < 10; i++) state.items.push(item(String(i)));
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            state.items.unshift(item("90"));
            state.items.splice(5, 1, item("10"), item("11"));
            state.items[3] = item("93");
            state.items.push(item("94"));
            state.items.splice(0, 0, item("95"));
            decodedState.decode(state.encode());

            assert.deepStrictEqual(
                decodedState.items.map(nameOf),
                ["95", "90", "0", "1", "93", "3", "10", "11", "5", "6", "7", "8", "9", "94"],
            );
            assertRefIdCounts(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("index write then reverse()", () => {
            assertSameTick(["a", "b", "c"], (arr, wrap) => {
                arr[0] = wrap("a2");
                arr.reverse();
            }, ["c", "b", "a2"]);
        });

        it("index write then sort()", () => {
            assertSameTick(["d", "b", "c", "a"], (arr, wrap) => {
                arr[0] = wrap("z");
                arr.sort(byName);
            }, ["a", "b", "c", "z"]);
        });

        it("sort() then index write", () => {
            assertSameTick(["d", "b", "c", "a"], (arr, wrap) => {
                arr.sort(byName);
                arr[3] = wrap("z");
            }, ["a", "b", "c", "z"]);
        });

        it("index write then untracked sort(): the write ships, the order stays on the server", () => {
            const { state, decodedState } = synced(["d", "b", "c", "a"]);
            for (const [arr, wrap] of [[state.items, item], [state.strings, (name: string) => name]] as const) {
                (arr as ArraySchema<any>)[0] = wrap("z");
                arr.untracked(() => arr.sort(byName));
            }
            assert.deepStrictEqual(state.items.map(nameOf), ["a", "b", "c", "z"]);
            assert.deepStrictEqual([...state.strings], ["a", "b", "c", "z"]);

            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["z", "b", "c", "a"]);
            assert.deepStrictEqual([...decodedState.strings], ["z", "b", "c", "a"]);
            assertRefIdCounts(state, decodedState);
        });

        it("index write then pop() deletes the element the client holds", () => {
            const { state, decodedState } = synced(["a", "b"]);
            state.items[1] = item("c");
            state.items.pop();
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["a"]);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
        });

        it("unshift() then an index write over the unshifted slot", () => {
            const { state, decodedState } = synced(["a", "b"]);
            state.items.unshift(item("c"));
            state.items[0] = item("d");
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["d", "a", "b"]);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
        });

        it("index write, then unshift() of the overwritten value", () => {
            const state = new State();
            state.numbers.push(1, 2);
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            state.numbers[0] = 3;
            state.numbers.unshift(1);
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(Array.from(decodedState.numbers), [1, 3, 2]);
        });

        it("index write, then unshift() of the overwritten instance", () => {
            const { state, decodedState } = synced(["a", "b"]);
            const first = state.items[0];
            state.items[0] = item("c");
            state.items.unshift(first);
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["a", "c", "b"]);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
        });
    });

    describe("inside move()", () => {
        class Card extends Schema {
            @type("uint16") id: number;
        }
        class Deck extends Schema {
            @type([Card]) cards = new ArraySchema<Card>();
        }
        const card = (id: number) => new Card().assign({ id });

        it("swaps written through the state's own array are one reorder", () => {
            const state = new Deck();
            state.cards.push(card(2), card(3), card(4), card(5));
            const decodedState = new Deck();
            decodedState.decode(state.encode());

            state.cards.push(card(6));
            state.cards.move(() => {
                [state.cards[4], state.cards[3]] = [state.cards[3], state.cards[4]];
                [state.cards[3], state.cards[2]] = [state.cards[2], state.cards[3]];
                [state.cards[2], state.cards[0]] = [state.cards[0], state.cards[2]];
                [state.cards[1], state.cards[1]] = [state.cards[1], state.cards[1]];
                [state.cards[0], state.cards[0]] = [state.cards[0], state.cards[0]];
            });
            decodedState.decode(state.encode());

            assert.deepStrictEqual(state.cards.map((c) => c.id), [6, 3, 2, 4, 5]);
            assert.deepStrictEqual(decodedState.cards.toJSON(), state.cards.toJSON());
            assertRefIdCounts(state, decodedState);
            assert.strictEqual(getDecoder(decodedState).root.refs.size, 7);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a swap after a splice() keeps every card's refCount at 1", () => {
            const state = new Deck();
            const encoder = getEncoder(state);
            state.cards.push(card(2), card(3), card(4), card(5));
            const decodedState = new Deck();
            decodedState.decode(state.encode());

            state.cards.splice(2, 1);
            state.cards.move(() => {
                [state.cards[2], state.cards[0]] = [state.cards[0], state.cards[2]];
            });
            for (let i = 0; i < 3; i++) {
                assert.strictEqual(1, encoder.root.refCount.get(state.cards[i][$refId]));
            }

            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.cards.map((c) => c.id), [5, 3, 2]);
            assertRefIdCounts(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("with a StateView", () => {
        it("index write on a @view() array, mixed with push() and unshift()", () => {
            class ViewState extends Schema {
                @view() @type(["number"]) nums = new ArraySchema<number>();
            }
            const state = new ViewState();
            const encoder = getEncoder(state);
            state.nums.push(1, 2, 3);

            const client = createClientWithView(state);
            client.view.add(state.nums);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual([1, 2, 3], client.state.nums.toJSON());

            state.nums.unshift(0);
            state.nums.unshift(-1);
            encodeMultiple(encoder, state, [client]);

            state.nums[2] = 99;
            state.nums.push(4);
            state.nums.unshift(-2);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual([-2, -1, 0, 99, 2, 3, 4], client.state.nums.toJSON());
        });

        it("index write of a child with @view() fields: only its viewers get the field", () => {
            class Player extends Schema {
                @type("string") name: string;
                @view() @type("number") secret: number;
            }
            class Room extends Schema {
                @type([Player]) players = new ArraySchema<Player>();
            }
            const make = (name: string, secret: number) => new Player().assign({ name, secret });
            const state = new Room();
            const encoder = getEncoder(state);
            state.players.push(make("d", 1), make("b", 2), make("a", 3));

            const viewer = createClientWithView(state);
            const other = createClientWithView(state);
            encodeMultiple(encoder, state, [viewer, other]);

            state.players.sort((a, b) => a.name.localeCompare(b.name));
            const added = make("z", 4);
            state.players[1] = added;
            viewer.view.add(added);
            encodeMultiple(encoder, state, [viewer, other]);

            const describe = (players: Player[]) => players.map((p) => p.secret === undefined ? p.name : `${p.name}=${p.secret}`);
            assert.deepStrictEqual(describe(viewer.state.players), ["a", "z=4", "d"]);
            assert.deepStrictEqual(describe(other.state.players), ["a", "z", "d"]);
        });
    });

    describe("`slice()`, `concat()` and `with()` return an ArraySchema", () => {
        it("#concat()", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            const concat = arr.concat([4, 5, 6]);
            assert.deepStrictEqual([1, 2, 3, 4, 5, 6], concat.toJSON());
        });

        it("#with()", () => {
            const arr = new ArraySchema<number>(1, 2, 3, 4, 5);
            assert.deepStrictEqual([1, 6, 3, 4, 5], arr.with(1, 6).toJSON());
            assert.deepStrictEqual([1, 2, 3, 4, 7], arr.with(-1, 7).toJSON());
            assert.deepStrictEqual([1, 2, 3, 8, 5], arr.with(-2, 8).toJSON());
        });

        it("the result is an ArraySchema with its methods", () => {
            const arr = new ArraySchema<number>(3, 1, 2);
            for (const copy of [arr.slice(), arr.concat(), arr.with(0, 3)] as ArraySchema<number>[]) {
                assert.ok(copy instanceof ArraySchema);
                assert.notStrictEqual(copy, arr);
                assert.deepStrictEqual(copy.toArray(), [3, 1, 2]);
                assert.deepStrictEqual(copy.clone().toJSON(), [3, 1, 2]);
                copy.clear();
                assert.strictEqual(copy.length, 0);
            }
            assert.deepStrictEqual(arr.toJSON(), [3, 1, 2]);
        });

        it("with the mode off they return plain arrays", () => {
            enableLegacyCompat(false);
            try {
                const arr = new ArraySchema<number>(1, 2, 3);
                for (const copy of [arr.slice(), arr.concat([4]), arr.with(0, 9)]) {
                    assert.ok(Array.isArray(copy));
                    assert.ok(!(copy instanceof ArraySchema));
                }
            } finally {
                enableLegacyCompat();
            }
        });

        it("a copy assigned to the state stays the tracked instance", () => {
            const { state, decodedState } = synced(["a", "b", "c", "d"]);

            const items = state.items.slice(1) as ArraySchema<Item>;
            state.items = items;
            assert.strictEqual(state.items, items);
            encodeAndAssertEquals(state, decodedState);

            // mutations made through the reference kept from slice()
            items.push(item("e"));
            items[0] = item("B");
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["B", "c", "d", "e"]);

            const strings = state.strings.concat(["e"]);
            strings.push("f");
            state.strings = strings;
            state.strings = state.strings.with(0, "A");
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.strings.toJSON(), ["A", "b", "c", "d", "e", "f"]);

            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a copy edited before it is assigned ships its final contents", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            const items = state.items.slice() as ArraySchema<Item>;
            items.pop();
            items.unshift(item("front"));
            state.items = items;
            encodeAndAssertEquals(state, decodedState);
            assert.deepStrictEqual(decodedState.items.map(nameOf), ["front", "a", "b"]);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
        });

        it("elements shared by the original and an assigned copy stay in sync through removals", () => {
            class Two extends Schema {
                @type([Item]) items = new ArraySchema<Item>();
                @type([Item]) other = new ArraySchema<Item>();
            }
            const state = new Two();
            const decodedState = createInstanceFromReflection(state);
            state.items.push(item("a"), item("b"), item("c"));
            decodedState.decode(state.encode());

            state.other = state.items.slice() as ArraySchema<Item>;
            encodeAndAssertEquals(state, decodedState);
            state.other[1].name = "shared";
            encodeAndAssertEquals(state, decodedState);
            assert.strictEqual(decodedState.items[1].name, "shared");

            state.items.shift();
            encodeAndAssertEquals(state, decodedState);
            assertRefIdCounts(state, decodedState);

            state.other.clear();
            encodeAndAssertEquals(state, decodedState);
            assertRefIdCounts(state, decodedState);
            assertNoOrphanRefs(state, decodedState);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("throwaway copies leave nothing behind on the elements", () => {
            const { state, decodedState } = synced(["a", "b", "c"]);
            const parents = () => getAllParents(state.items[0][$changes]).length;
            const before = parents();
            for (let i = 0; i < 100; i++) {
                state.items.slice().sort(byName);
                state.items.concat([]);
            }
            assert.strictEqual(parents(), before);

            // a discarded copy that drops an element does not release it
            (state.items.slice() as ArraySchema<Item>).shift();
            state.items[0].name = "still here";
            encodeAndAssertEquals(state, decodedState);
            assertRefIdCounts(state, decodedState);
        });
    });

    describe("change tracking", () => {
        it("an index write while tracking is paused stays on the server", () => {
            const { state, decodedState } = synced(["a", "b"]);
            state.strings.untracked(() => { state.strings[0] = "local"; });
            assert.strictEqual(state.strings[0], "local");
            assert.strictEqual(state.strings[$changes].changed, false);
            decodedState.decode(state.encode());
            assert.deepStrictEqual(decodedState.strings.toJSON(), ["a", "b"]);
        });

        it("an element of the wrong type is rejected, as with set()", () => {
            const state = new State();
            state.items.push(item("a"));
            assert.throws(() => { (state.items as any)[0] = new State(); });
            assert.deepStrictEqual(state.items.map(nameOf), ["a"]);
        });
    });
});
