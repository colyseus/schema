import * as assert from "assert";
import { Schema, type, view, schema, t, ArraySchema, QueueSchema, StateView, ARRAY_OP } from "../src";
import { $changes } from "../src/types/symbols";
import { ArrayLog } from "../src/encoder/ArrayLog";
import {
    createInstanceFromReflection, assertDeepStrictEqualEncodeAll, assertRefIdCounts, getEncoder, getCallbacks,
    createClientWithView, encodeMultiple,
} from "./Schema";

class Item extends Schema {
    @type("number") value: number = 0;
}

class State extends Schema {
    @type(["number"]) numbers = new QueueSchema<number>();
    @type([Item]) items = new QueueSchema<Item>();
}

function item(value: number) {
    const i = new Item();
    i.value = value;
    return i;
}

describe("QueueSchema", () => {
    it("push / shift / at / peek / length / iteration", () => {
        const queue = new QueueSchema<number>(1, 2, 3);
        assert.strictEqual(queue.length, 3);
        assert.strictEqual(queue.shift(), 1);
        queue.push(4, 5);
        assert.strictEqual(queue.length, 4);
        assert.strictEqual(queue.peek(), 2);
        assert.strictEqual(queue.at(0), 2);
        assert.strictEqual(queue.at(-1), 5);
        assert.strictEqual(queue.at(4), undefined);
        assert.strictEqual(queue.at(-5), undefined);
        assert.deepStrictEqual([...queue], [2, 3, 4, 5]);
        assert.deepStrictEqual(queue.toArray(), [2, 3, 4, 5]);
        assert.strictEqual(JSON.stringify(queue), "[2,3,4,5]");
        const seen: number[][] = [];
        queue.forEach((v, i) => seen.push([i, v]));
        assert.deepStrictEqual(seen, [[0, 2], [1, 3], [2, 4], [3, 5]]);
        queue.clear();
        assert.strictEqual(queue.length, 0);
        assert.strictEqual(queue.shift(), undefined);
        assert.throws(() => queue.push(undefined as any), /null nor undefined/);
    });

    it("travels as an array: the client holds an ArraySchema", () => {
        const state = new State();
        state.numbers.push(1, 2, 3);
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        assert.ok((client.numbers as any) instanceof ArraySchema);
        assert.deepStrictEqual(client.numbers.toJSON(), [1, 2, 3]);

        state.numbers.shift();
        state.numbers.push(4);
        const log = (state.numbers as any)[$changes].rec as ArrayLog;
        assert.deepStrictEqual(log.ops, [ARRAY_OP.REMOVE, 0, 1, ARRAY_OP.PUSH, 1, 2]);
        client.decode(state.encode());
        assert.deepStrictEqual(client.numbers.toJSON(), [2, 3, 4]);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("Schema children: a long push / shift run stays in sync, refs released", () => {
        const state = new State();
        for (let i = 0; i < 100; i++) state.items.push(item(i));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        let adds = 0, removes = 0;
        const $ = getCallbacks(client);
        $(client).items.onAdd(() => adds++, false);
        $(client).items.onRemove(() => removes++);

        let next = 100;
        for (let tick = 0; tick < 400; tick++) {
            const n = 1 + (tick % 3);
            for (let k = 0; k < n; k++) state.items.shift();
            for (let k = 0; k < n; k++) state.items.push(item(next++));
            if (tick % 50 === 7) { // a client joining while the front is dead storage
                const late = createInstanceFromReflection(state);
                late.decode(getEncoder(state).encodeAll());
                assert.deepStrictEqual(late.items.map((i) => i.value), state.items.toArray().map((i) => i.value));
            }
            client.decode(state.encode());
            getEncoder(state).discardChanges();
        }

        assert.strictEqual(state.items.length, 100);
        assert.strictEqual(state.items.peek()!.value, next - 100);
        assert.deepStrictEqual(client.items.map((i) => i.value), state.items.toArray().map((i) => i.value));
        assert.strictEqual(adds, removes);
        assert.strictEqual(adds, next - 100);
        assertRefIdCounts(state, client);
        assertDeepStrictEqualEncodeAll(state);
    });

    it("an element pushed and shifted in the same tick never reaches the wire", () => {
        const state = new State();
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        state.items.push(item(1));
        state.items.shift();
        assert.strictEqual(((state.items as any)[$changes].rec as ArrayLog).size(), 0);
        state.items.push(item(2));
        client.decode(state.encode());
        assert.deepStrictEqual(client.items.map((i) => i.value), [2]);
        assertRefIdCounts(state, client);
    });

    it("clear() and replacing the queue", () => {
        const state = new State();
        state.items.push(item(1), item(2));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        getEncoder(state).discardChanges();

        state.items.clear();
        state.items.push(item(3));
        client.decode(state.encode());
        getEncoder(state).discardChanges();
        assert.deepStrictEqual(client.items.map((i) => i.value), [3]);

        state.items = new QueueSchema<Item>(item(4), item(5));
        client.decode(state.encode());
        assert.deepStrictEqual(client.items.map((i) => i.value), [4, 5]);
        assertRefIdCounts(state, client);
    });

    it("behind @view(): elements reach the views that hold them", () => {
        class ViewState extends Schema {
            @view() @type([Item]) items = new QueueSchema<Item>();
        }
        const state = new ViewState();
        const encoder = getEncoder(state);
        for (let i = 0; i < 4; i++) state.items.push(item(i));

        const client = createClientWithView(state);
        client.view.add(state.items.at(1)!);
        client.view.add(state.items.at(3)!);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(client.state.items.map((i) => i.value), [1, 3]);

        state.items.shift();
        state.items.shift(); // value 1: held by the view
        const added = item(9);
        state.items.push(added);
        client.view.add(added);
        encodeMultiple(encoder, state, [client]);
        assert.deepStrictEqual(client.state.items.map((i) => i.value).sort(), [3, 9]);
    });

    it("t.queue(): an array field whose default is a QueueSchema", () => {
        const Entry = schema({ score: t.number() }, "QueueEntry");
        const Board = schema({ entries: t.queue(Entry), ids: t.queue("number") }, "QueueBoard");
        const state = new Board();
        assert.ok(state.entries instanceof QueueSchema);

        state.ids.push(1, 2);
        state.entries.push(new Entry().assign({ score: 5 }));
        const client = createInstanceFromReflection(state);
        client.decode(state.encodeAll());
        assert.deepStrictEqual(client.toJSON(), { entries: [{ score: 5 }], ids: [1, 2] });
    });
});
