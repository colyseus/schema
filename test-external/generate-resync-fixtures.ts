//
// Generates decode-side byte fixtures for the decodeResync SDK ports
// (PORTING_RESYNC.md). Scenarios mirror test/ResyncSweep.test.ts — the
// portable subset: Map + Array collections (SDKs implement no Set/Stream).
//
// Every scenario is SELF-VERIFYING: the captured byte sequence is replayed
// against the 5.0 JS Decoder (static classes, like the SDKs use) and the
// behavioral contract asserted — a fixture that doesn't reproduce aborts.
//
// Run: npx tsx test-external/generate-resync-fixtures.ts
//
import * as assert from "assert";
import { Schema, type, view, transient, ArraySchema, MapSchema, Encoder, Decoder, StateView } from "../src";
import { Callbacks } from "../src/decoder/strategy/Callbacks";
import {
    Gem, Unit, ResyncState, ResyncArrayState,
    ResyncPlayerV1, ResyncStateV1, ResyncTransientState,
} from "./ResyncFixtures";

//
// Server-only variants — wire-compatible with the client classes above.
//
class ViewArrayState extends Schema {
    @view() @type([Unit]) arr = new ArraySchema<Unit>();
}
class ServerTransientState extends Schema {
    @type({ map: Unit }) units = new MapSchema<Unit>();
    @transient @type({ map: "number" }) locals = new MapSchema<number>();
}
class PlayerV2 extends Schema {
    @type("number") x: number;
    @type("string") extra: string;
}
class StateV2 extends Schema {
    @type({ map: PlayerV2 }) players = new MapSchema<PlayerV2>();
}

const mkUnit = (name: string, gems: number = 0) => {
    const u = new Unit().assign({ name, hp: 100 });
    for (let i = 0; i < gems; i++) u.gems.push(new Gem().assign({ price: i }));
    return u;
};

class Fixture {
    buffers: Array<{ label: string, bytes: number[] }> = [];
    notes: string[] = [];
    constructor(public name: string) {}

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
    fn(f);
    fixtures.push(f);
    console.error(`✔ ${name}`);
}

function drain(encoder: Encoder) {
    encoder.encode();
    encoder.discardChanges();
}

function captureWarnings(fn: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.map(String).join(" "));
    try { fn(); } finally { console.warn = original; }
    return warnings;
}

function assertNoWarnings(fn: () => void) {
    const warnings = captureWarnings(fn);
    assert.deepStrictEqual(warnings, []);
}

// -----------------------------------------------------------------------------
// 1. ghost entities deleted while off the wire (MapSchema of Schema)
// -----------------------------------------------------------------------------
scenario("resync_ghost_map", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));
    state.units.set("e2", mkUnit("two"));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const removed: Array<[Unit, string]> = [];
    Callbacks.get(client).onRemove("units", (u: Unit, k: string) => removed.push([u, k]));
    const ghost = client.state.units.get("e2")!;

    // offline: e2 dies; the DELETE patch is never delivered
    state.units.delete("e2");
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());
    assert.strictEqual(client.state.units.size, 1);
    assert.strictEqual(removed.length, 1);
    assert.strictEqual(removed[0][0], ghost);
    assert.strictEqual(removed[0][1], "e2");

    f.note("after resync: units.size == 1 (only e1); exactly ONE onRemove with the ORIGINAL e2 instance and key e2");
    f.note(`decoder refs count after resync: ${client.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// 2. primitive map entries pruned by key
// -----------------------------------------------------------------------------
scenario("resync_prune_primitive_map", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.trees.set("t1", 10);
    state.trees.set("t2", 20);
    state.trees.set("t3", 30);

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const removed: Array<[number, string]> = [];
    Callbacks.get(client).onRemove("trees", (v: number, k: string) => removed.push([v, k]));

    state.trees.delete("t2");
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());
    assert.deepStrictEqual([...client.state.trees.keys()].sort(), ["t1", "t3"]);
    assert.deepStrictEqual(removed, [[20, "t2"]]);

    f.note("after resync: trees keys == [t1, t3]; exactly ONE onRemove: (20, t2)");
});

// -----------------------------------------------------------------------------
// 3. nested collections of retained parents (hero.gems)
// -----------------------------------------------------------------------------
scenario("resync_nested_collection", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("hero", mkUnit("hero", 3));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const heroBefore = client.state.units.get("hero")!;

    // offline: hero loses the middle gem
    state.units.get("hero")!.gems.splice(1, 1);
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.units.get("hero"), heroBefore, "retained parent keeps identity");
    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());
    assert.strictEqual(client.state.units.get("hero")!.gems.length, 2);

    f.note("after resync: hero is the SAME instance; hero.gems.length == 2 with prices [0, 2]");
});

// -----------------------------------------------------------------------------
// 4. interior array entries under a StateView (ADD_BY_REFID resolution)
// -----------------------------------------------------------------------------
scenario("resync_view_interior", (f) => {
    const state = new ViewArrayState();
    const encoder = new Encoder(state);
    const [a, b, c] = [mkUnit("a"), mkUnit("b"), mkUnit("c")];
    state.arr.push(a, b, c);

    const stateView = new StateView();
    stateView.add(a); stateView.add(b); stateView.add(c);

    const encodeView = () => {
        const buf = new Uint8Array(4096);
        const it = { offset: 0 };
        const sharedOffset = encoder.encodeAll(it, buf).byteLength;
        return encoder.encodeAllView(stateView, sharedOffset, it, buf);
    };

    // client class is the plain (view-less) twin — view is encode-side only
    const client = new Decoder(new ResyncArrayState());
    client.decode(f.capture("join_snapshot", encodeView()));
    assert.strictEqual(client.state.arr.length, 3);

    // offline: b leaves the view (fog) — an interior index, not the tail
    stateView.remove(b);
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encodeView())));

    assert.deepStrictEqual(client.state.arr.map((e) => e.name), ["a", "c"], "interior entry swept + compacted");

    f.note("snapshots are view-encoded (ADD_BY_REFID ops); after resync: arr names == [a, c] — interior entry swept and array compacted");
});

// -----------------------------------------------------------------------------
// 5. collection emptied server-side → fully swept
// -----------------------------------------------------------------------------
scenario("resync_emptied_collection", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));
    state.units.set("e2", mkUnit("two"));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    let removals = 0;
    Callbacks.get(client).onRemove("units", () => removals++);

    state.units.clear();
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.units.size, 0);
    assert.strictEqual(removals, 2);

    f.note("after resync: units.size == 0; exactly TWO onRemove calls");
});

// -----------------------------------------------------------------------------
// 6. no double-decrement for swept entities carrying nested collections
// -----------------------------------------------------------------------------
scenario("resync_no_double_decrement", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("rich", mkUnit("rich", 5));
    state.units.set("keep", mkUnit("keep", 2));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    state.units.delete("rich"); // nested gems go with it (GC transitive)
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

    f.note("after resync: only 'keep' remains (2 gems); no decoder warnings; nested gem refs released exactly once");
    f.note(`decoder refs count after resync: ${client.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// 7. late DELETE patch arriving after the sweep → tolerated, no re-fire
// -----------------------------------------------------------------------------
scenario("resync_late_delete", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));
    state.units.set("e2", mkUnit("two"));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    let removals = 0;
    Callbacks.get(client).onRemove("units", () => removals++);

    // the DELETE patch is encoded but arrives AFTER the resync
    state.units.delete("e2");
    const latePatch = f.capture("late_patch", encoder.encode());
    encoder.discardChanges();

    client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll()));
    assert.strictEqual(removals, 1);

    assertNoWarnings(() => client.decode(latePatch));

    assert.strictEqual(removals, 1, "onRemove must not re-fire");
    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

    f.note("decode order: join_snapshot, resync_snapshot (as resync), late_patch (plain decode)");
    f.note("exactly ONE onRemove total — the late DELETE for the already-swept entry is a silent no-op");
});

// -----------------------------------------------------------------------------
// 9. survivor identity, no onAdd re-fire, listeners stay wired
// -----------------------------------------------------------------------------
scenario("resync_survivor_identity", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));
    state.units.set("gone", mkUnit("gone"));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const survivor = client.state.units.get("e1")!;

    let adds = 0;
    const hpValues: number[] = [];
    const callbacks = Callbacks.get(client);
    callbacks.onAdd("units", () => adds++, false);
    callbacks.listen(survivor, "hp", (hp: number) => hpValues.push(hp), false);

    // offline: survivor changes, sibling dies
    state.units.get("e1")!.hp = 55;
    state.units.delete("gone");
    drain(encoder);

    client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll()));

    assert.strictEqual(client.state.units.get("e1"), survivor, "same instance across resync");
    assert.strictEqual(adds, 0, "onAdd must not re-fire for survivors");
    assert.deepStrictEqual(hpValues, [55]);

    // callbacks stay wired for live patches after the resync
    state.units.get("e1")!.hp = 77;
    const postPatch = f.capture("post_resync_patch", encoder.encode());
    encoder.discardChanges();
    client.decode(postPatch);
    assert.deepStrictEqual(hpValues, [55, 77]);

    f.note("after resync: e1 is the SAME instance, zero onAdd re-fires, hp listener saw [55]");
    f.note("after post_resync_patch (plain decode): hp listener saw [55, 77] — listeners survive resync");
});

// -----------------------------------------------------------------------------
// 10. entity re-keyed while offline → same instance, one onRemove + one onAdd
// -----------------------------------------------------------------------------
scenario("resync_rekey", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    const mover = mkUnit("mover");
    state.units.set("old", mover);

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const instance = client.state.units.get("old")!;

    const adds: string[] = [];
    const removes: string[] = [];
    const callbacks = Callbacks.get(client);
    callbacks.onAdd("units", (_: Unit, key: string) => adds.push(key), false);
    callbacks.onRemove("units", (_: Unit, key: string) => removes.push(key));

    // offline: same server instance moves to a new key
    state.units.delete("old");
    state.units.set("new", mover);
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.units.get("new"), instance, "same instance under the new key");
    assert.strictEqual(client.state.units.get("old"), undefined);
    assert.deepStrictEqual(adds, ["new"]);
    assert.deepStrictEqual(removes, ["old"]);

    f.note("after resync: SAME instance now under key 'new'; onAdd fired once ('new'), onRemove once ('old')");
    f.note(`decoder refs count after resync: ${client.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// 11. key replaced by a NEW instance while offline → old released + GC'd
// -----------------------------------------------------------------------------
scenario("resync_replace_same_key", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("k", mkUnit("first", 2));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const oldInstance = client.state.units.get("k")!;

    const adds: Unit[] = [];
    const removes: Unit[] = [];
    const callbacks = Callbacks.get(client);
    callbacks.onAdd("units", (u: Unit) => adds.push(u), false);
    callbacks.onRemove("units", (u: Unit) => removes.push(u));

    // offline: the entity at "k" dies and a NEW one spawns at the same key
    state.units.delete("k");
    drain(encoder);
    state.units.set("k", mkUnit("second"));
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.units.get("k")!.name, "second");
    assert.notStrictEqual(client.state.units.get("k"), oldInstance);
    assert.deepStrictEqual(removes, [oldInstance]);
    assert.strictEqual(adds.length, 1);
    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

    f.note("after resync: units[k].name == 'second' and it is a FRESH instance; onRemove carried the OLD instance; old refId GC'd");
    f.note(`decoder refs count after resync: ${client.root.refs.size}`);
});

// -----------------------------------------------------------------------------
// 12. damaged payload (version skew) → sweep aborted, ghost retained
// -----------------------------------------------------------------------------
scenario("resync_damaged", (f) => {
    // v1 server: client joins with p1 + p2
    const serverV1 = new ResyncStateV1();
    const encoderV1 = new Encoder(serverV1);
    serverV1.players.set("p1", new ResyncPlayerV1().assign({ x: 1 }));
    serverV1.players.set("p2", new ResyncPlayerV1().assign({ x: 2 }));

    const client = new Decoder(new ResyncStateV1());
    client.decode(f.capture("join_snapshot_v1", encoderV1.encodeAll()));

    // rejoin lands on a v2 server that only has p1 → p2 is a ghost the sweep
    // WOULD remove — but the payload can't be fully decoded (unknown field).
    const serverV2 = new StateV2();
    const encoderV2 = new Encoder(serverV2);
    serverV2.players.set("p1", new PlayerV2().assign({ x: 1, extra: "hi" }));

    const warnings = captureWarnings(() => {
        client.decodeResync(f.capture("resync_snapshot_v2", encoderV2.encodeAll()));
    });

    assert.ok(warnings.some((w) => w.includes("field not defined")));
    assert.ok(warnings.some((w) => w.includes("resync sweep skipped")));
    assert.strictEqual(client.state.players.size, 2, "sweep aborted — ghost retained");

    f.note("client uses the V1 classes; resync_snapshot_v2 has an unknown field → schema-mismatch skip → damage flag");
    f.note("after resync: players.size == 2 — sweep ABORTED (ghost p2 retained), no crash");
});

// -----------------------------------------------------------------------------
// 13. transient collection untouched (never part of a snapshot)
// -----------------------------------------------------------------------------
scenario("resync_transient", (f) => {
    const state = new ServerTransientState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));
    state.locals.set("l1", 1);
    state.locals.set("l2", 2);

    // client class is the plain twin (no transient marker — SDKs don't need one)
    const client = new Decoder(new ResyncTransientState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    client.decode(f.capture("patch_with_locals", encoder.encode())); // transient entries arrive via patch only
    encoder.discardChanges();

    assert.strictEqual(client.state.locals.size, 2);

    state.units.set("e2", mkUnit("two"));
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.locals.size, 2, "transient data must survive the sweep");
    assert.strictEqual(client.state.units.size, 2);

    f.note("locals arrive only via patch_with_locals; the resync snapshot never mentions them");
    f.note("after resync: locals.size == 2 (untouched — presence rule), units.size == 2");
});

// -----------------------------------------------------------------------------
// 14. plain decode of a full snapshot stays additive (resync is opt-in)
// -----------------------------------------------------------------------------
scenario("resync_plain_additive", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("e1", mkUnit("one"));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    state.units.set("e2", mkUnit("two"));
    const patch1 = f.capture("patch_add_e2", encoder.encode());
    encoder.discardChanges();
    client.decode(patch1);

    state.units.delete("e1");
    drain(encoder); // this DELETE patch is dropped — never delivered

    state.units.get("e2")!.hp = 42;
    const patch2 = f.capture("patch_hp", encoder.encode());
    encoder.discardChanges();
    client.decode(patch2);

    assert.strictEqual(client.state.units.size, 2, "plain decode stays additive");

    client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll()));
    assert.strictEqual(client.state.units.size, 1, "resync reconciles");
    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

    f.note("decode join_snapshot, patch_add_e2, patch_hp as PLAIN decodes → units.size == 2 (ghost e1 kept)");
    f.note("then resync_snapshot as RESYNC → units.size == 1 (only e2, hp 42)");
});

// -----------------------------------------------------------------------------
// 15. array tail-trim: entries dropped from the end while offline
// -----------------------------------------------------------------------------
scenario("resync_tail_trim", (f) => {
    const state = new ResyncState();
    const encoder = new Encoder(state);
    state.units.set("hero", mkUnit("hero", 4));

    const client = new Decoder(new ResyncState());
    client.decode(f.capture("join_snapshot", encoder.encodeAll()));
    drain(encoder);

    const gems = state.units.get("hero")!.gems;
    gems.pop();
    gems.pop();
    drain(encoder);

    assertNoWarnings(() => client.decodeResync(f.capture("resync_snapshot", encoder.encodeAll())));

    assert.strictEqual(client.state.units.get("hero")!.gems.length, 2);
    assert.deepStrictEqual(client.state.toJSON(), state.toJSON());

    f.note("after resync: hero.gems.length == 2 with prices [0, 1]");
    f.note(`decoder refs count after resync: ${client.root.refs.size}`);
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
