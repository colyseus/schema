import * as assert from "assert";
import { Schema, type, view, ArraySchema, MapSchema, Encoder, Decoder, StateView, OPERATION, ARRAY_OP } from "../src";
import { $changes, $rev } from "../src/types/symbols";
import { ArrayLog } from "../src/encoder/ArrayLog";
import {
    createInstanceFromReflection, assertDeepStrictEqualEncodeAll, assertRefIdCounts, getEncoder, getDecoder,
    getCallbacks, createClientWithView, encodeMultiple, encodeAllForView,
} from "./Schema";

class Item extends Schema {
    @type("string") name: string;
    @type("number") value: number = 0;
}

class State extends Schema {
    @type(["number"]) numbers = new ArraySchema<number>();
    @type([Item]) items = new ArraySchema<Item>();
}

function item(name: string, value = 0) {
    const i = new Item();
    i.name = name;
    i.value = value;
    return i;
}

/** A second client that joins by `encodeAll` at this instant of the tick. */
function join<T extends Schema>(state: T) {
    const client = createInstanceFromReflection(state);
    client.decode(getEncoder(state).encodeAll());
    return client;
}

describe("ArraySchema wire format (op log + revision)", () => {

    describe("revision gate (mid-tick join)", () => {
        it("primitive array: a client that joined between two pushes applies only the later push", () => {
            const state = new State();
            const early = createInstanceFromReflection(state);
            early.decode(state.encodeAll());

            state.numbers.push(1, 2);
            const late = join(state);
            assert.deepStrictEqual(late.numbers.toJSON(), [1, 2]);
            assert.strictEqual(late.numbers[$rev], 2);

            state.numbers.push(3);
            const patch = state.encode();
            early.decode(patch);
            late.decode(patch);

            assert.deepStrictEqual(early.numbers.toJSON(), [1, 2, 3]);
            assert.deepStrictEqual(late.numbers.toJSON(), [1, 2, 3]);
            assert.strictEqual(late.numbers[$rev], 3);
        });

        it("Schema array: no duplicated element, refcounts in parity, onAdd once per element", () => {
            const state = new State();
            const early = createInstanceFromReflection(state);
            early.decode(state.encodeAll());

            state.items.push(item("a"), item("b"));
            const late = join(state);

            let adds = 0;
            getCallbacks(late)(late).items.onAdd(() => adds++, false);

            state.items.push(item("c"));
            state.items[0].value = 10;
            const patch = state.encode();
            early.decode(patch);
            late.decode(patch);

            assert.deepStrictEqual(early.toJSON(), state.toJSON());
            assert.deepStrictEqual(late.toJSON(), state.toJSON());
            assert.strictEqual(adds, 1, "only 'c' is new to the late joiner");
            assertRefIdCounts(state, early);
            assertRefIdCounts(state, late);
        });

        it("partial application inside a coalesced REMOVE", () => {
            const state = new State();
            state.numbers.push(1, 2, 3, 4, 5);
            state.encode();

            state.numbers.shift();
            const late = join(state); // holds [2,3,4,5] at rev 6
            state.numbers.shift();
            state.numbers.shift(); // REMOVE(0, 3) on the wire

            const early = createInstanceFromReflection(state);
            // (a client that never saw the array gets it through the patch's RESTATE-less ops: use encodeAll first)
            early.decode(state.encodeAll());
            const patch = state.encode();
            late.decode(patch);
            early.decode(patch);

            assert.deepStrictEqual(late.numbers.toJSON(), [4, 5]);
            assert.deepStrictEqual(early.numbers.toJSON(), [4, 5]);
        });

        it("join then pop / sort / clear in the same tick", () => {
            const state = new State();
            state.items.push(item("c", 3), item("a", 1), item("b", 2));
            const late = join(state);

            state.items.pop();
            state.items.sort((x, y) => x.value - y.value);
            state.items.push(item("d", 4));
            const patch = state.encode();
            late.decode(patch);
            assert.deepStrictEqual(late.items.map((i) => i.name), ["a", "c", "d"]);
            assertRefIdCounts(state, late);

            state.items.clear();
            state.items.push(item("e"));
            late.decode(state.encode());
            assert.deepStrictEqual(late.items.map((i) => i.name), ["e"]);
            assertRefIdCounts(state, late);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("a value pushed and popped in the same tick never reaches the wire", () => {
            const state = new State();
            getEncoder(state);
            state.items.push(item("ghost"));
            state.items.pop();
            const patch = state.encode();
            const client = createInstanceFromReflection(state);
            client.decode(patch);
            assert.strictEqual(client.items.length, 0);
            assert.strictEqual(getDecoder(client).root.refs.size, 3); // root + two arrays
            assertRefIdCounts(state, client);
        });
    });

    describe("reorders", () => {
        it("sort() records one REORDER and fires onChange for moved slots only", () => {
            const state = new State();
            state.items.push(item("c", 3), item("a", 1), item("b", 2));
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();

            let adds = 0, removes = 0;
            const changed: number[] = [];
            const $ = getCallbacks(client);
            $(client).items.onAdd(() => adds++, false);
            $(client).items.onRemove(() => removes++);
            $(client).items.onChange((_, index) => changed.push(index));

            state.items.sort((x, y) => x.value - y.value);
            const log = (state.items as any)[$changes].rec as ArrayLog;
            assert.strictEqual(log.size(), 1);
            client.decode(state.encode());

            assert.deepStrictEqual(client.items.map((i) => i.name), ["a", "b", "c"]);
            assert.strictEqual(adds, 0);
            assert.strictEqual(removes, 0);
            assert.deepStrictEqual(changed.sort(), [0, 1, 2]);
            assertRefIdCounts(state, client);
        });

        it("sort() that changes nothing records nothing", () => {
            const state = new State();
            state.numbers.push(1, 2, 3);
            state.encode();
            state.numbers.sort((a, b) => a - b);
            assert.strictEqual(getEncoder(state).hasChanges, false);
        });

        it("reverse() + move() on primitives", () => {
            const state = new State();
            state.numbers.push(1, 2, 3, 4);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());

            state.numbers.reverse();
            state.numbers.move((arr) => { [arr[0], arr[3]] = [arr[3], arr[0]]; });
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), [1, 3, 2, 4]);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("move() whose callback changes membership falls back to a re-statement", () => {
            const state = new State();
            state.items.push(item("a"), item("b"));
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());

            state.items.move((arr) => { arr[1] = item("c"); });
            client.decode(state.encode());
            assert.deepStrictEqual(client.items.map((i) => i.name), ["a", "c"]);
            assertRefIdCounts(state, client);
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("Array subclass behaviour", () => {
        it("is a real Array; derived arrays are plain arrays", () => {
            const arr = new ArraySchema<number>(1, 2, 3);
            assert.ok(Array.isArray(arr));
            assert.ok(arr instanceof ArraySchema);
            assert.ok(arr instanceof Array);
            assert.ok(!(arr.map((v) => v * 2) instanceof ArraySchema));
            assert.deepStrictEqual(arr.filter((v) => v > 1), [2, 3]);
            assert.deepStrictEqual([...arr], [1, 2, 3]);
            assert.strictEqual(JSON.stringify(arr), "[1,2,3]");
        });

        it("writes past the end append; delete arr[i] removes; length grows are ignored", () => {
            const state = new State();
            getEncoder(state);
            state.numbers[0] = 1;
            state.numbers[5] = 6; // appends
            assert.deepStrictEqual(state.numbers.toJSON(), [1, 6]);
            delete state.numbers[0];
            assert.deepStrictEqual(state.numbers.toJSON(), [6]);
            state.numbers.length = 10;
            assert.strictEqual(state.numbers.length, 1);
            const client = createInstanceFromReflection(state);
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), [6]);
        });

        it("fill() and copyWithin() are tracked", () => {
            const state = new State();
            state.numbers.push(1, 2, 3, 4, 5);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            state.numbers.fill(0, 1, 3);
            state.numbers.copyWithin(0, 3);
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), state.numbers.toJSON());
            assert.deepStrictEqual(client.numbers.toJSON(), [4, 5, 0, 4, 5]);
        });

        it("ArraySchema.from / .of are tracked", () => {
            class S extends Schema { @type(["string"]) tags = new ArraySchema<string>(); }
            const state = new S();
            getEncoder(state);
            state.tags = ArraySchema.from(new Set(["x", "y"]));
            const client = createInstanceFromReflection(state);
            client.decode(state.encode());
            assert.deepStrictEqual(client.tags.toJSON(), ["x", "y"]);
            state.tags = ArraySchema.of("z");
            client.decode(state.encode());
            assert.deepStrictEqual(client.tags.toJSON(), ["z"]);
        });

        it("encodes 200 numbers in one tick (chunk length past 127 bytes)", () => {
            const state = new State();
            getEncoder(state);
            for (let i = 0; i < 200; i++) state.numbers.push(i * 1000);
            const client = createInstanceFromReflection(state);
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), state.numbers.toJSON());
            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("filtered arrays (identity mode)", () => {
        class Card extends Schema {
            @type("string") suit: string;
        }
        class Table extends Schema {
            @view() @type([Card]) cards = new ArraySchema<Card>();
            @view() @type(["number"]) scores = new ArraySchema<number>();
        }
        function card(suit: string) { const c = new Card(); c.suit = suit; return c; }

        it("each view holds exactly the elements it was granted; positions are not synced", () => {
            const state = new Table();
            const encoder = getEncoder(state); // the helpers memoize one encoder per state
            state.cards.push(card("a"), card("b"), card("c"));

            const client1 = createClientWithView(state);
            const client2 = createClientWithView(state);
            client1.view.add(state.cards[0]);
            client1.view.add(state.cards[2]);
            client2.view.add(state.cards[1]);
            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.cards.map((c) => c.suit).sort(), ["a", "c"]);
            assert.deepStrictEqual(client2.state.cards.map((c) => c.suit), ["b"]);

            // splice out a visible element, unshift + reverse (no positional ops reach filtered clients)
            state.cards.splice(0, 1);
            state.cards.unshift(card("d"));
            state.cards.reverse();
            client2.view.add(state.cards.find((c) => c.suit === "d"));
            encodeMultiple(encoder, state, [client1, client2]);

            assert.deepStrictEqual(client1.state.cards.map((c) => c.suit), ["c"]);
            assert.deepStrictEqual(client2.state.cards.map((c) => c.suit).sort(), ["b", "d"]);
            // each client holds only its subset: no orphan refs, and every held ref is live on the encoder
            for (const client of [client1, client2]) {
                for (const refId of getDecoder(client.state).root.refs.keys()) {
                    assert.ok(encoder.root.refCount[refId] > 0, `orphan refId ${refId}`);
                }
            }
        });

        it("view.add(primitive array under @view) drains as a positional re-statement", () => {
            const state = new Table();
            const encoder = getEncoder(state);
            state.scores.push(10, 20, 30);
            encoder.encode(); encoder.discardChanges();

            const client = createClientWithView(state);
            encodeAllForView(encoder, client);
            assert.strictEqual(client.state.scores, undefined); // @view field: nothing until granted

            client.view.add(state.scores);
            state.scores.push(40);
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(client.state.scores.toJSON(), [10, 20, 30, 40]);

            state.scores.shift();
            encodeMultiple(encoder, state, [client]);
            assert.deepStrictEqual(client.state.scores.toJSON(), [20, 30, 40]);
        });
    });

    describe("wire size", () => {
        it("a steady-state index write is refId, length, op with the index folded in, value", () => {
            const state = new State();
            state.numbers.push(1, 2, 3);
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();

            state.numbers[0] = 9;
            const bytes = state.encode();
            assert.strictEqual(bytes.byteLength, 4, Buffer.from(bytes).toString("hex"));
            assert.strictEqual(bytes[2], 0 * 16 + ARRAY_OP.SET);
            client.decode(bytes);
            assert.deepStrictEqual(client.numbers.toJSON(), [9, 2, 3]);

            state.numbers[2] = 7;
            state.numbers.pop();
            state.numbers.push(8);
            client.decode(state.encode());
            assert.deepStrictEqual(client.numbers.toJSON(), [9, 2, 8]);
        });

        it("BASE rides only in a tick that snapshotted the array", () => {
            const state = new State();
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());
            getEncoder(state).discardChanges();

            state.numbers.push(1);
            const early = join(state); // snapshot at revision 1, mid-tick
            state.numbers.push(2);
            const tick1 = state.encode();
            assert.strictEqual(tick1[2], 0 * 16 + ARRAY_OP.BASE, Buffer.from(tick1).toString("hex"));
            assert.strictEqual(tick1[3], 2 * 16 + ARRAY_OP.PUSH); // both pushes coalesced
            client.decode(tick1);
            early.decode(tick1);
            assert.deepStrictEqual(client.numbers.toJSON(), [1, 2]);
            assert.deepStrictEqual(early.numbers.toJSON(), [1, 2]);

            state.numbers.push(3);
            const tick2 = state.encode();
            assert.strictEqual(tick2[2], 1 * 16 + ARRAY_OP.PUSH, Buffer.from(tick2).toString("hex")); // no BASE
            assert.strictEqual(tick2.byteLength, 4);
            client.decode(tick2);
            early.decode(tick2);
            assert.deepStrictEqual(client.numbers.toJSON(), [1, 2, 3]);
            assert.deepStrictEqual(early.numbers.toJSON(), [1, 2, 3]);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("binding a new element of a filtered array to a view ships that element only", () => {
            class Row extends Schema {
                @type("string") text: string;
            }
            class Feed extends Schema {
                @view() @type([Row]) rows = new ArraySchema<Row>();
            }
            const state = new Feed();
            const encoder = getEncoder(state);
            const mk = (i: number) => { const r = new Row(); r.text = "row" + i; return r; };
            for (let i = 0; i < 100; i++) state.rows.push(mk(i));

            const clients = [createClientWithView(state), createClientWithView(state)];
            for (const c of clients) state.rows.forEach((row) => c.view.add(row));
            encodeMultiple(encoder, state, clients);
            for (const c of clients) assert.deepStrictEqual(c.state.rows.toJSON(), state.rows.toJSON());

            // ring buffer: shift the oldest, push a new row, grant it to every view
            for (let tick = 0; tick < 3; tick++) {
                state.rows.shift();
                const row = mk(100 + tick);
                state.rows.push(row);
                for (const c of clients) c.view.add(row);
                const patches = encodeMultiple(encoder, state, clients);
                for (let i = 0; i < clients.length; i++) {
                    assert.ok(patches[i].byteLength < 48, `patch of ${patches[i].byteLength} bytes: ${Buffer.from(patches[i]).toString("hex")}`);
                    assert.deepStrictEqual(clients[i].state.rows.toJSON(), state.rows.toJSON());
                }
            }
        });
    });
});
