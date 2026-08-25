import * as assert from "assert";
import { Schema, type, view, patchOnly, MapSchema, ArraySchema, SetSchema, StreamSchema, StateView } from "../src";
import { Callbacks } from "../src/decoder/strategy/Callbacks";
import { $refId } from "../src/types/symbols";
import {
    getEncoder, getDecoder, createInstanceFromReflection,
    assertRefIdCounts, assertNoOrphanRefs,
    createClientWithView, type ClientWithState,
} from "./Schema";

class Item extends Schema {
    @type("number") price: number = 0;
}
class Entity extends Schema {
    @type("string") name: string = "";
    @type("number") hp: number = 0;
    @type([Item]) items = new ArraySchema<Item>();
}
class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
    @type({ map: "number" }) trees = new MapSchema<number>();
}

const mkEntity = (name: string, items: number = 0) => {
    const e = new Entity().assign({ name, hp: 100 });
    for (let i = 0; i < items; i++) e.items.push(new Item().assign({ price: i }));
    return e;
};

/** join flow: reflection instance + full decode. */
function join(state: State): State {
    const client = createInstanceFromReflection(state);
    client.decode(getEncoder(state).encodeAll());
    return client;
}

/** rejoin flow: full snapshot applied over existing client state. */
function resync<T extends Schema>(state: T, client: T) {
    getDecoder(client).decodeResync(getEncoder(state).encodeAll());
}

/** capture console.warn calls (DecodingWarning, sweep-skip, mismatch spam). */
function captureWarnings(fn: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.map(String).join(" "));
    try { fn(); } finally { console.warn = original; }
    return warnings;
}

describe("Resync sweep (decodeResync)", () => {

    it("removes ghost entities deleted while off the wire (MapSchema of Schema)", () => {
        const state = new State();
        state.entities.set("e1", mkEntity("one"));
        state.entities.set("e2", mkEntity("two"));
        const client = join(state);

        const removed: Array<[Entity, string]> = [];
        const callbacks = Callbacks.get(getDecoder(client));
        callbacks.onRemove("entities", (entity: Entity, key: string) => removed.push([entity, key]));

        const ghost = client.entities.get("e2")!;

        // offline: e2 dies; the DELETE patch is never delivered
        state.entities.delete("e2");
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.strictEqual(client.entities.size, 1);
        assert.strictEqual(removed.length, 1);
        assert.strictEqual(removed[0][0], ghost, "onRemove must carry the real previous instance");
        assert.strictEqual(removed[0][1], "e2");
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("prunes primitive map entries by key (no child refs involved)", () => {
        const state = new State();
        state.trees.set("t1", 10);
        state.trees.set("t2", 20);
        state.trees.set("t3", 30);
        const client = join(state);

        const removed: Array<[number, string]> = [];
        Callbacks.get(getDecoder(client)).onRemove("trees", (v: number, k: string) => removed.push([v, k]));

        state.trees.delete("t2");
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual([...client.trees.keys()].sort(), ["t1", "t3"]);
        assert.deepStrictEqual(removed, [[20, "t2"]]);
        assert.deepStrictEqual(warnings, []);
    });

    it("sweeps nested collections of retained parents (hero.items)", () => {
        const state = new State();
        state.entities.set("hero", mkEntity("hero", 3));
        const client = join(state);
        const heroBefore = client.entities.get("hero")!;

        // offline: hero loses the middle item
        state.entities.get("hero")!.items.splice(1, 1);
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.entities.get("hero"), heroBefore, "retained parent keeps identity");
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.strictEqual(client.entities.get("hero")!.items.length, 2);
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("sweeps interior array entries under a StateView (ADD_BY_REFID resolution)", () => {
        class ViewState extends Schema {
            @view() @type([Entity]) arr = new ArraySchema<Entity>();
        }
        const state = new ViewState();
        const encoder = getEncoder(state);
        const [a, b, c] = [mkEntity("a"), mkEntity("b"), mkEntity("c")];
        state.arr.push(a, b, c);

        const client: ClientWithState<ViewState> = createClientWithView(state);
        client.view.add(a); client.view.add(b); client.view.add(c);

        const encodeView = () => {
            const buf = new Uint8Array(4096);
            const it = { offset: 0 };
            const sharedOffset = encoder.encodeAll(it, buf).byteLength;
            return encoder.encodeAllView(client.view, sharedOffset, it, buf);
        };
        client.state.decode(encodeView());
        assert.strictEqual(client.state.arr.length, 3);

        // offline: b leaves the view (fog) — an interior index, not the tail
        client.view.remove(b);
        encoder.encode(); encoder.discardChanges();

        const warnings = captureWarnings(() => client.decoder.decodeResync(encodeView()));

        assert.deepStrictEqual(client.state.arr.map((e) => e.name), ["a", "c"], "interior entry swept + compacted");
        assert.deepStrictEqual(warnings, []);
    });

    it("sweeps a collection the snapshot no longer mentions (emptied server-side)", () => {
        const state = new State();
        state.entities.set("e1", mkEntity("one"));
        state.entities.set("e2", mkEntity("two"));
        const client = join(state);

        let removals = 0;
        Callbacks.get(getDecoder(client)).onRemove("entities", () => removals++);

        state.entities.clear();
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.entities.size, 0);
        assert.strictEqual(removals, 2);
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("does not double-decrement refs of swept entities carrying nested collections", () => {
        const state = new State();
        state.entities.set("rich", mkEntity("rich", 5));
        state.entities.set("keep", mkEntity("keep", 2));
        const client = join(state);

        state.entities.delete("rich"); // nested items go with it (GC transitive)
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.deepStrictEqual(warnings, [], "no DecodingWarning may fire");
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("tolerates a late DELETE patch for an entry the sweep already removed", () => {
        const state = new State();
        state.entities.set("e1", mkEntity("one"));
        state.entities.set("e2", mkEntity("two"));
        const client = join(state);

        let removals = 0;
        Callbacks.get(getDecoder(client)).onRemove("entities", () => removals++);

        // the DELETE patch is encoded but arrives AFTER the resync
        state.entities.delete("e2");
        const latePatch = state.encode();

        resync(state, client);
        assert.strictEqual(removals, 1);

        const warnings = captureWarnings(() => client.decode(latePatch));

        assert.strictEqual(removals, 1, "onRemove must not re-fire");
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });

    it("retains StreamSchema entries (streams are not part of full-sync)", () => {
        class StreamState extends Schema {
            @type({ stream: Entity }) feed = new StreamSchema<Entity>();
        }
        const state = new StreamState();
        getEncoder(state);
        state.feed.add(mkEntity("first"));
        state.feed.add(mkEntity("second"));

        const client = createInstanceFromReflection(state);
        client.decode(getEncoder(state).encodeAll());
        client.decode(state.encode()); // entries arrive via trickle, not full-sync
        assert.strictEqual(client.feed.length, 2);

        const warnings = captureWarnings(() => resync(state as any, client as any));

        assert.strictEqual(client.feed.length, 2, "trickled entries must survive a resync");
        assert.deepStrictEqual(warnings, []);
    });

    it("keeps survivor identity, does not re-fire onAdd, and keeps listen() wired", () => {
        const state = new State();
        state.entities.set("e1", mkEntity("one"));
        state.entities.set("gone", mkEntity("gone"));
        const client = join(state);
        const survivor = client.entities.get("e1")!;

        let adds = 0;
        const hpValues: number[] = [];
        const callbacks = Callbacks.get(getDecoder(client));
        callbacks.onAdd("entities", () => adds++, false);
        callbacks.listen(survivor, "hp", (hp: number) => hpValues.push(hp), false);

        // offline: survivor changes, sibling dies
        state.entities.get("e1")!.hp = 55;
        state.entities.delete("gone");
        state.encode();

        resync(state, client);

        assert.strictEqual(client.entities.get("e1"), survivor, "same instance across resync");
        assert.strictEqual(adds, 0, "onAdd must not re-fire for survivors");
        assert.deepStrictEqual(hpValues, [55], "field listener fires with the resynced value");

        // callbacks stay wired for live patches after the resync
        state.entities.get("e1")!.hp = 77;
        client.decode(state.encode());
        assert.deepStrictEqual(hpValues, [55, 77]);
    });

    it("keeps identity of an entity re-keyed while offline (one onRemove + one onAdd)", () => {
        const state = new State();
        const e = mkEntity("mover");
        state.entities.set("old", e);
        const client = join(state);
        const instance = client.entities.get("old")!;

        const adds: string[] = [];
        const removes: string[] = [];
        const callbacks = Callbacks.get(getDecoder(client));
        callbacks.onAdd("entities", (_: Entity, key: string) => adds.push(key), false);
        callbacks.onRemove("entities", (_: Entity, key: string) => removes.push(key));

        // offline: same server instance moves to a new key
        state.entities.delete("old");
        state.entities.set("new", e);
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.entities.get("new"), instance, "same instance under the new key");
        assert.strictEqual(client.entities.get("old"), undefined);
        assert.deepStrictEqual(adds, ["new"]);
        assert.deepStrictEqual(removes, ["old"]);
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("releases the previous occupant when a key was replaced while offline", () => {
        const state = new State();
        state.entities.set("k", mkEntity("first", 2));
        const client = join(state);
        const oldInstance = client.entities.get("k")!;
        const oldRefId = (oldInstance as any)[$refId];

        const adds: Entity[] = [];
        const removes: Entity[] = [];
        const callbacks = Callbacks.get(getDecoder(client));
        callbacks.onAdd("entities", (entity: Entity) => adds.push(entity), false);
        callbacks.onRemove("entities", (entity: Entity) => removes.push(entity));

        // offline: the entity at "k" dies and a NEW one spawns at the same key
        state.entities.delete("k");
        state.encode();
        state.entities.set("k", mkEntity("second"));
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.entities.get("k")!.name, "second");
        assert.notStrictEqual(client.entities.get("k"), oldInstance, "must be a fresh instance");
        assert.deepStrictEqual(removes, [oldInstance]);
        assert.strictEqual(adds.length, 1);
        assert.strictEqual(getDecoder(client).root.refs.has(oldRefId), false, "old ref must be GC'd");
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("aborts the sweep when the payload could not be fully decoded", () => {
        // Version skew: the resync payload comes from a server whose Player
        // has an extra field. decodeSchemaOperation checks `metadata[index]`
        // BEFORE reading value bytes, so the unknown index is a clean,
        // deterministic mismatch → skipCurrentStructure → damage flag.
        class PlayerV1 extends Schema {
            @type("number") x: number = 0;
        }
        class StateV1 extends Schema {
            @type({ map: PlayerV1 }) players = new MapSchema<PlayerV1>();
        }
        class PlayerV2 extends Schema {
            @type("number") x: number = 0;
            @type("string") extra: string = "";
        }
        class StateV2 extends Schema {
            @type({ map: PlayerV2 }) players = new MapSchema<PlayerV2>();
        }

        // v1 server: client joins with p1 + p2
        const serverV1 = new StateV1();
        serverV1.players.set("p1", new PlayerV1().assign({ x: 1 }));
        serverV1.players.set("p2", new PlayerV1().assign({ x: 2 }));
        const client = createInstanceFromReflection(serverV1);
        client.decode(getEncoder(serverV1).encodeAll());

        // rejoin lands on a v2 server that only has p1 → p2 is a ghost the
        // sweep WOULD remove — but the payload can't be fully decoded.
        const serverV2 = new StateV2();
        serverV2.players.set("p1", new PlayerV2().assign({ x: 1, extra: "hi" }));

        const warnings = captureWarnings(() => {
            getDecoder(client).decodeResync(getEncoder(serverV2).encodeAll());
        });

        // degraded mode, by design: mismatch detected, sweep aborted, no throw.
        // Keeping a ghost one more resync beats deleting live entries based on
        // incomplete visited data.
        assert.ok(warnings.some((w) => w.includes("field not defined")), `expected mismatch warning, got: ${warnings}`);
        assert.ok(warnings.some((w) => w.includes("resync sweep skipped")), `expected sweep-skip warning, got: ${warnings}`);
        assert.strictEqual(client.players.size, 2, "sweep aborted — ghost retained rather than risk deleting live entries");
    });

    it("leaves @patchOnly collections alone (never part of a snapshot)", () => {
        class PatchOnlyState extends Schema {
            @type({ map: Entity }) entities = new MapSchema<Entity>();
            @patchOnly @type({ map: "number" }) locals = new MapSchema<number>();
        }
        const state = new PatchOnlyState();
        state.entities.set("e1", mkEntity("one"));
        state.locals.set("l1", 1);
        state.locals.set("l2", 2);

        const client = createInstanceFromReflection(state);
        client.decode(getEncoder(state).encodeAll());
        client.decode(state.encode()); // patchOnly entries arrive via patch only

        assert.strictEqual(client.locals.size, 2);

        state.entities.set("e2", mkEntity("two"));
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.locals.size, 2, "@patchOnly data must survive the sweep");
        assert.strictEqual(client.entities.size, 2);
        assert.deepStrictEqual(warnings, []);
    });

    it("sweeps SetSchema entries by index", () => {
        class SetState extends Schema {
            @type({ set: Entity }) squad = new SetSchema<Entity>();
        }
        const state = new SetState();
        getEncoder(state);
        const [a, b, c] = [mkEntity("a"), mkEntity("b"), mkEntity("c")];
        state.squad.add(a); state.squad.add(b); state.squad.add(c);

        const client = createInstanceFromReflection(state);
        client.decode(getEncoder(state).encodeAll());
        assert.strictEqual(client.squad.size, 3);

        state.squad.delete(b);
        state.encode();

        const warnings = captureWarnings(() => resync(state as any, client as any));

        assert.strictEqual(client.squad.size, 2);
        assert.deepStrictEqual([...client.squad].map((e) => e.name).sort(), ["a", "c"]);
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state as any, client as any);
        assertNoOrphanRefs(state as any, client as any);
    });

    it("array tail-trim: entries dropped from the end while offline", () => {
        const state = new State();
        state.entities.set("hero", mkEntity("hero", 4));
        const client = join(state);

        const items = state.entities.get("hero")!.items;
        items.pop();
        items.pop();
        state.encode();

        const warnings = captureWarnings(() => resync(state, client));

        assert.strictEqual(client.entities.get("hero")!.items.length, 2);
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
        assert.deepStrictEqual(warnings, []);
        assertRefIdCounts(state, client);
        assertNoOrphanRefs(state, client);
    });

    it("regular decode path is unaffected (resync mode is opt-in per call)", () => {
        const state = new State();
        state.entities.set("e1", mkEntity("one"));
        const client = join(state);

        // plain patches never sweep — an undelivered DELETE stays stale (the bug
        // this feature exists for), and the next resync reconciles it.
        state.entities.set("e2", mkEntity("two"));
        client.decode(state.encode());
        state.entities.delete("e1");
        state.encode(); // dropped
        state.entities.get("e2")!.hp = 42;
        client.decode(state.encode());

        assert.strictEqual(client.entities.size, 2, "plain decode stays additive");

        resync(state, client);
        assert.strictEqual(client.entities.size, 1, "resync reconciles");
        assert.deepStrictEqual(client.toJSON(), state.toJSON());
    });
});
