//
// Generates decode-side byte fixtures for the SDK ports of the 5.0
// ArraySchema wire-semantics changes (TODO/sdk-decoders-arrayschema-insert.md):
//
//   - "ADD at occupied index = insert" (schema#219)
//   - DELETE_BY_REFID idempotency guards (schema#220)
//   - MOVE / MOVE_AND_ADD opcode pinning
//
// Every scenario is SELF-VERIFYING: the captured bytes are decoded with the
// 5.0 JS Decoder and the end state asserted — a fixture that doesn't
// reproduce the JS result aborts generation.
//
// Run: npx tsx test-external/generate-arrayschema-fixtures.ts
//
// The printed byte lists paste verbatim into:
//   C#   → new byte[] { ... }        Haxe → getBytes([ ... ])
//   Lua  → { ... }                   Zig  → [_]u8{ ... }
//
import * as assert from "assert";
import { Encoder, Decoder, OPERATION } from "../src";
import { ArraySchemaInsertOps, Item, Player } from "./ArraySchemaInsertOps";

const mkItem = (value: number) => new Item().assign({ value });
const mkPlayer = (name: string, x: number, y: number) => new Player().assign({ name, x, y });

class Fixture {
    buffers: Array<{ label: string, bytes: number[] }> = [];
    notes: string[] = [];
    constructor(public name: string) {}

    // copy immediately — encoder.encode() returns a view into a shared buffer
    capture(label: string, bytes: Uint8Array): Uint8Array {
        const copied = Array.from(bytes);
        this.buffers.push({ label, bytes: copied });
        return Uint8Array.from(copied);
    }

    note(text: string) { this.notes.push(text); }
}

const fixtures: Fixture[] = [];

function scenario(name: string, fn: (f: Fixture) => void) {
    const f = new Fixture(name);
    fn(f); // assertion failure aborts generation
    fixtures.push(f);
    console.error(`✔ ${name}`);
}

function countOps(decoder: Decoder<any>, op: OPERATION): { count: number } {
    const counter = { count: 0 };
    decoder.triggerChanges = (changes) => {
        counter.count += changes.filter((c) => c.op === op).length;
    };
    return counter;
}

// -----------------------------------------------------------------------------
// 1. consecutive unshift (test/ArraySchema.test.ts "consecutive unshift calls")
// -----------------------------------------------------------------------------
scenario("unshift_consecutive", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.numbers.push(1, 2, 3);

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    state.numbers.unshift(0);
    state.numbers.unshift(-1);

    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();

    assert.deepStrictEqual(client.state.numbers.toJSON(), [-1, 0, 1, 2, 3]);
    f.note("expected numbers: [-1, 0, 1, 2, 3]");
});

// -----------------------------------------------------------------------------
// 2. multi-item unshift
// -----------------------------------------------------------------------------
scenario("unshift_multi", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.numbers.push(1, 2, 3);

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    state.numbers.unshift(-1, -2);

    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();

    assert.deepStrictEqual(client.state.numbers.toJSON(), [-1, -2, 1, 2, 3]);
    f.note("expected numbers: [-1, -2, 1, 2, 3]");
});

// -----------------------------------------------------------------------------
// 3. unshift with pending same-tick operations (REPLACE + ADD re-keyed)
// -----------------------------------------------------------------------------
scenario("unshift_same_tick_ops", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.numbers.push(1, 2, 3);

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    state.numbers[2] = 99;
    state.numbers.push(4);
    state.numbers.unshift(0);

    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();

    assert.deepStrictEqual(client.state.numbers.toJSON(), [0, 1, 2, 99, 4]);
    f.note("expected numbers: [0, 1, 2, 99, 4]");
});

// -----------------------------------------------------------------------------
// 4. consecutive unshift of Schema instances (ref-counted, no refId leaks)
// -----------------------------------------------------------------------------
scenario("unshift_schema_instances", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.items.push(mkItem(1), mkItem(2));

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    state.items.unshift(mkItem(0));
    state.items.unshift(mkItem(-1));

    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();

    assert.deepStrictEqual(client.state.items.map((i) => i.value), [-1, 0, 1, 2]);
    const refsCount = client.root.refs.size;
    f.note(`expected items.value: [-1, 0, 1, 2]`);
    f.note(`expected decoder refs count after patch1: ${refsCount}`);
});

// -----------------------------------------------------------------------------
// 5. clear + unshift in the same tick
// -----------------------------------------------------------------------------
scenario("clear_unshift_same_tick", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.numbers.push(1, 2, 3);

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    state.numbers.clear();
    state.numbers.unshift(9);
    state.numbers.unshift(8);

    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();

    assert.deepStrictEqual(client.state.numbers.toJSON(), [8, 9]);
    f.note("expected numbers: [8, 9]");
});

// -----------------------------------------------------------------------------
// 6. sort() must NOT insert (REPLACE at occupied indexes, incl. index 0)
// -----------------------------------------------------------------------------
scenario("sort_no_insert", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.players.push(mkPlayer("One", 10, 0));
    state.players.push(mkPlayer("Two", 30, 1));
    state.players.push(mkPlayer("Three", 20, 2));
    state.players.push(mkPlayer("Four", 50, 3));
    state.players.push(mkPlayer("Five", 40, 4));

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();
    assert.deepStrictEqual(client.state.players.map((p) => p.name), ["One", "Two", "Three", "Four", "Five"]);

    state.players.sort((a, b) => b.y - a.y);
    client.decode(f.capture("patch1", encoder.encode()));
    encoder.discardChanges();
    assert.strictEqual(client.state.players.length, 5);
    assert.deepStrictEqual(client.state.players.map((p) => p.name), ["Five", "Four", "Three", "Two", "One"]);

    state.players.sort((a, b) => a.x - b.x);
    client.decode(f.capture("patch2", encoder.encode()));
    encoder.discardChanges();
    assert.strictEqual(client.state.players.length, 5);
    assert.deepStrictEqual(client.state.players.map((p) => p.name), ["One", "Three", "Two", "Five", "Four"]);

    f.note("expected names after snapshot: [One, Two, Three, Four, Five]");
    f.note("expected names after patch1:   [Five, Four, Three, Two, One] (length stays 5)");
    f.note("expected names after patch2:   [One, Three, Two, Five, Four] (length stays 5)");
});

// -----------------------------------------------------------------------------
// 7. mid-tick join: stale DELETE_BY_REFIDs in shared patch (idempotency)
// -----------------------------------------------------------------------------
scenario("stale_delete_mid_tick_join", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    for (let i = 0; i < 5; i++) state.items.push(mkItem(i));

    const oldClient = new Decoder(new ArraySchemaInsertOps());
    oldClient.decode(f.capture("snapshot_old", encoder.encodeAll()));
    oldClient.decode(f.capture("patch_baseline", encoder.encode()));
    encoder.discardChanges();

    // tick in progress: deletions recorded, not yet broadcast
    state.items.shift();
    state.items.shift();

    // fresh client joins mid-tick — snapshot already reflects deletions
    const freshClient = new Decoder(new ArraySchemaInsertOps());
    freshClient.decode(f.capture("snapshot_fresh", encoder.encodeAll()));

    state.items.shift();

    // same patch bytes broadcast to both
    const patch = f.capture("shared_patch", encoder.encode());
    encoder.discardChanges();

    const oldDeletes = countOps(oldClient, OPERATION.DELETE);
    const freshDeletes = countOps(freshClient, OPERATION.DELETE);
    oldClient.decode(patch);
    freshClient.decode(Uint8Array.from(patch));

    assert.deepStrictEqual(oldClient.state.toJSON(), state.toJSON());
    assert.deepStrictEqual(freshClient.state.toJSON(), state.toJSON());
    assert.strictEqual(oldClient.root.refs.size, freshClient.root.refs.size);

    f.note(`expected items.value on both clients after shared_patch: [3, 4]`);
    f.note(`expected DELETE DataChanges from shared_patch — old client: ${oldDeletes.count}, fresh client: ${freshDeletes.count} (stale refIds skipped silently)`);
    f.note(`expected decoder refs count on both clients: ${oldClient.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// 8. move()/shuffle: MOVE (32) and MOVE_AND_ADD (160) opcode pinning
// -----------------------------------------------------------------------------
scenario("move_shuffle", (f) => {
    const state = new ArraySchemaInsertOps();
    const encoder = new Encoder(state);
    state.items.push(mkItem(1), mkItem(2), mkItem(3));

    const client = new Decoder(new ArraySchemaInsertOps());
    client.decode(f.capture("snapshot", encoder.encode()));
    encoder.discardChanges();

    // swap two existing instances → MOVE (32)
    state.items.move((arr) => {
        const tmp = arr[0];
        arr[0] = arr[1];
        arr[1] = tmp;
    });

    const patch1 = f.capture("patch1", encoder.encode());
    encoder.discardChanges();
    assert.ok(patch1.includes(OPERATION.MOVE), "patch1 must carry a MOVE (32) opcode");

    client.decode(patch1);
    assert.deepStrictEqual(client.state.items.map((i) => i.value), [2, 1, 3]);

    // NEW instance written at an occupied slot → MOVE_AND_ADD (160)
    state.items.move((arr) => {
        arr[2] = mkItem(9);
    });

    const patch2 = f.capture("patch2", encoder.encode());
    encoder.discardChanges();
    assert.ok(patch2.includes(OPERATION.MOVE_AND_ADD), "patch2 must carry a MOVE_AND_ADD (160) opcode");

    client.decode(patch2);
    assert.deepStrictEqual(client.state.items.map((i) => i.value), [2, 1, 9]);

    f.note("expected items.value after patch1: [2, 1, 3] (MOVE=32 present in patch1)");
    f.note("expected items.value after patch2: [2, 1, 9] (MOVE_AND_ADD=160 present in patch2)");
    f.note(`expected decoder refs count after patch2: ${client.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// output
// -----------------------------------------------------------------------------
for (const f of fixtures) {
    console.log(`\n=== ${f.name} ===`);
    for (const { label, bytes } of f.buffers) {
        console.log(`${label} (${bytes.length} bytes):`);
        console.log(`  ${bytes.join(", ")}`);
    }
    for (const note of f.notes) console.log(`// ${note}`);
}
console.error(`\nAll ${fixtures.length} scenarios self-verified against the 5.0 JS Decoder.`);
