import * as assert from "assert";
import { Schema, type, MapSchema, ArraySchema, type SchemaPool, createPool, $changes, $refId } from "../src";
import { getEncoder, getDecoder, createInstanceFromReflection, assertRefIdCounts, assertDeepStrictEqualEncodeAll } from "./Schema";

class Position extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
}
class Item extends Schema {
    @type("number") price: number = 0;
}
class Entity extends Schema {
    @type("string") name: string = "";
    @type(Position) position = new Position();
    @type({ map: Item }) items = new MapSchema<Item>();
}
class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

const spawn = (pool: SchemaPool<Entity>, name: string, x: number, items: number) => {
    const e = pool.acquire();
    e.name = name;
    e.position.x = x;
    e.position.y = x * 2;
    for (let i = 0; i < items; i++) e.items.set("i" + i, new Item().assign({ price: i }));
    return e;
};

describe("SchemaPool", () => {
    it("release() leaves a pristine, detached ChangeTree", () => {
        const state = new State();
        getEncoder(state);
        const pool = createPool(Entity);

        const e = spawn(pool, "alice", 5, 2);
        state.entities.set("e", e);
        state.encode();

        state.entities.delete("e");
        state.encode();
        pool.release(e);

        const ct = (e as any)[$changes];
        assert.strictEqual((e as any)[$refId], undefined, "$refId must be dropped");
        assert.strictEqual(ct.root, undefined, "root must be detached");
        assert.strictEqual(ct.parentRef, undefined, "parentRef must be cleared");
        assert.strictEqual(ct.extraParents, undefined);
        assert.strictEqual(ct.isNew, true, "must be re-armed as IS_NEW");
        assert.strictEqual(ct.has(), false, "dirty bucket must be empty");
        assert.strictEqual(ct.changesNode, undefined);
        assert.strictEqual(ct.visibleViews, undefined);
        assert.strictEqual(ct.tagViews, undefined);
        assert.strictEqual(ct.subscribedViews, undefined);

        // nested ref children reset too
        assert.strictEqual((e.position as any)[$refId], undefined);
        assert.strictEqual((e.position as any)[$changes].root, undefined);
        assert.strictEqual((e.items as any)[$refId], undefined);
        assert.strictEqual((e.items as any)[$changes].root, undefined);
        assert.strictEqual(e.items.size, 0, "collection field must be emptied");

        assert.strictEqual(pool.size, 1);
    });

    it("round-trips correctly across spawn -> despawn -> respawn churn", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        const pool = createPool(Entity, { preallocate: 4 });

        decoded.decode(state.encode());

        for (let tick = 0; tick < 100; tick++) {
            // spawn 3 entities
            const a = spawn(pool, "a" + tick, tick, 2);
            const b = spawn(pool, "b" + tick, tick + 1, 1);
            const c = spawn(pool, "c" + tick, tick + 2, 3);
            state.entities.set("a", a);
            state.entities.set("b", b);
            state.entities.set("c", c);
            decoded.decode(state.encode());
            assert.deepStrictEqual(decoded.toJSON(), state.toJSON());

            // despawn all + release
            state.entities.delete("a");
            state.entities.delete("b");
            state.entities.delete("c");
            decoded.decode(state.encode());
            assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
            pool.release(a);
            pool.release(b);
            pool.release(c);
        }

        assertRefIdCounts(state, decoded);
    });

    it("produces byte-identical wire output to constructing fresh instances", () => {
        // Two independent encoders fed the SAME op sequence: one always `new`,
        // one pooled (so instances are genuinely recycled). Dropping $refId on
        // reset means the pooled side re-acquires ids in the same order, so the
        // encoded patches must match tick-for-tick.
        const fresh = new State();
        getEncoder(fresh);
        const pooled = new State();
        getEncoder(pooled);
        const pool = createPool(Entity);

        let recycled: Entity | undefined;

        for (let tick = 0; tick < 25; tick++) {
            // fresh side: brand-new instance every spawn
            const f = new Entity();
            f.name = "n" + tick; f.position.x = tick; f.items.set("i", new Item().assign({ price: tick }));
            fresh.entities.set("e", f);
            const bFresh = fresh.encode();

            // pooled side: same logical values, recycled instance after tick 0
            const p = recycled ? pool.acquire() : new Entity();
            p.name = "n" + tick; p.position.x = tick; p.items.set("i", new Item().assign({ price: tick }));
            pooled.entities.set("e", p);
            const bPooled = pooled.encode();

            assert.deepStrictEqual(Array.from(bPooled), Array.from(bFresh), `patch mismatch on spawn tick ${tick}`);

            // despawn both
            fresh.entities.delete("e");
            const dFresh = fresh.encode();
            pooled.entities.delete("e");
            const dPooled = pooled.encode();
            assert.deepStrictEqual(Array.from(dPooled), Array.from(dFresh), `patch mismatch on despawn tick ${tick}`);

            pool.release(p);
            recycled = p;
        }
    });

    it("reuses a recycled instance for a different entity with a fresh refId", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        const encoder = getEncoder(state);
        const pool = createPool(Entity);
        decoded.decode(state.encode());

        const alice = spawn(pool, "alice", 1, 0);
        state.entities.set("p", alice);
        decoded.decode(state.encode());

        state.entities.delete("p");
        decoded.decode(state.encode());
        pool.release(alice);

        // reacquire the SAME object, repurpose as "bob"
        const bob = pool.acquire();
        assert.strictEqual(bob, alice, "should reuse the pooled instance");
        bob.name = "bob"; bob.position.x = 99;
        state.entities.set("p", bob);
        decoded.decode(state.encode());

        const refId = (bob as any)[$refId];
        assert.ok(refId !== undefined && encoder.root.changeTrees[refId]?.ref === bob, "must hold a live, freshly-acquired refId");
        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
        assert.strictEqual(decoded.entities.get("p")!.name, "bob");
        assertRefIdCounts(state, decoded);
    });

    it("keeps a late-joining client consistent after churn (encodeAll)", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        const pool = createPool(Entity);
        decoded.decode(state.encode());

        for (let tick = 0; tick < 30; tick++) {
            const e = spawn(pool, "e" + tick, tick, 2);
            state.entities.set("e", e);
            decoded.decode(state.encode());
            state.entities.delete("e");
            decoded.decode(state.encode());
            pool.release(e);
        }
        // leave a couple alive
        state.entities.set("survivor", spawn(pool, "survivor", 7, 1));
        decoded.decode(state.encode());

        assertDeepStrictEqualEncodeAll(state);
    });

    describe("guards", () => {
        it("throws when resetting a shared instance (multiple parents)", () => {
            const state = new State();
            getEncoder(state);
            class Shared extends Schema { @type("number") n = 0; }
            class S2 extends Schema {
                @type({ map: Shared }) a = new MapSchema<Shared>();
                @type({ map: Shared }) b = new MapSchema<Shared>();
            }
            const s = new S2();
            getEncoder(s);
            const shared = new Shared();
            s.a.set("x", shared);
            s.b.set("x", shared); // same instance in two parents -> extraParents
            s.encode();
            assert.throws(() => Schema.reset(shared), /shared instance/);
        });

        it("throws when resetting a decoder-side (untracked) instance", () => {
            const decoded = createInstanceFromReflection(new State());
            const mirror = (Entity as any).initializeForDecoder();
            assert.throws(() => Schema.reset(mirror), /tracked .*instance/);
        });

        it("throws when releasing an instance still attached to the tree", () => {
            const state = new State();
            getEncoder(state);
            const pool = createPool(Entity);
            const e = spawn(pool, "x", 1, 0);
            state.entities.set("e", e);
            state.encode();
            assert.throws(() => pool.release(e), /attached/);
        });
    });

    it("resets collection fields (no stale indexes leak after reuse)", () => {
        const state = new State();
        const decoded = createInstanceFromReflection(state);
        const pool = createPool(Entity);
        decoded.decode(state.encode());

        const e = spawn(pool, "e", 0, 5); // 5 items -> journal index counter advances
        state.entities.set("e", e);
        decoded.decode(state.encode());
        state.entities.delete("e");
        decoded.decode(state.encode());
        pool.release(e);

        assert.strictEqual(e.items.size, 0);

        // reuse: re-fill with different items; fresh indexes must decode cleanly
        const reused = pool.acquire();
        assert.strictEqual(reused, e);
        reused.name = "again";
        reused.items.set("only", new Item().assign({ price: 42 }));
        state.entities.set("e", reused);
        decoded.decode(state.encode());

        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
        assert.strictEqual(decoded.entities.get("e")!.items.size, 1);
        assert.strictEqual(decoded.entities.get("e")!.items.get("only")!.price, 42);
        assertRefIdCounts(state, decoded);
    });

    it("supports ArraySchema fields", () => {
        class Inventory extends Schema {
            @type("string") owner = "";
            @type([Item]) items = new ArraySchema<Item>();
        }
        class S extends Schema { @type({ map: Inventory }) bags = new MapSchema<Inventory>(); }

        const state = new S();
        const decoded = createInstanceFromReflection(state);
        const pool = createPool(Inventory);
        decoded.decode(state.encode());

        const inv = pool.acquire();
        inv.owner = "alice";
        inv.items.push(new Item().assign({ price: 1 }), new Item().assign({ price: 2 }));
        state.bags.set("b", inv);
        decoded.decode(state.encode());
        state.bags.delete("b");
        decoded.decode(state.encode());
        pool.release(inv);

        assert.strictEqual(inv.items.length, 0, "array field emptied on reset");

        const reused = pool.acquire();
        assert.strictEqual(reused, inv);
        reused.owner = "bob";
        reused.items.push(new Item().assign({ price: 9 }));
        state.bags.set("b", reused);
        decoded.decode(state.encode());

        assert.deepStrictEqual(decoded.toJSON(), state.toJSON());
        assert.strictEqual(decoded.bags.get("b")!.items.length, 1);
        assert.strictEqual(decoded.bags.get("b")!.items[0].price, 9);
    });
});
