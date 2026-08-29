import * as assert from "assert";
import { Schema, type, MapSchema, ArraySchema, Encoder } from "../../src";
import { makeSides, join, tick, resync, report, type Side } from "./harness";

class Vec extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    constructor(x?: number, y?: number) { super(); if (x !== undefined) { this.x = x; this.y = y!; } }
}
class Item extends Schema {
    @type("string") name: string;
    @type("number") price: number;
    @type([Vec]) points = new ArraySchema<Vec>();
    constructor(name?: string, price?: number) { super(); if (name !== undefined) { this.name = name; this.price = price!; } }
}
class Entity extends Schema {
    @type("string") id: string;
    @type(Vec) pos = new Vec();
}
class Player extends Entity {
    @type("string") name: string;
    @type({ map: Item }) items = new MapSchema<Item>();
    @type(["number"]) scores = new ArraySchema<number>();
    @type([Item]) inventory = new ArraySchema<Item>();
    @type(Item) equipped: Item;
}
class Monster extends Entity {
    @type("number") hp: number;
}
class Prims extends Schema {
    @type("string") str: string;
    @type("number") num: number;
    @type("boolean") flag: boolean;
    @type("int8") i8: number;
    @type("uint8") u8: number;
    @type("int16") i16: number;
    @type("uint16") u16: number;
    @type("int32") i32: number;
    @type("uint32") u32: number;
    @type("int64") i64: number;
    @type("uint64") u64: number;
    @type("float32") f32: number;
    @type("float64") f64: number;
    @type("bigint64") big: bigint;
    @type("biguint64") ubig: bigint;
}
class State extends Schema {
    @type(Prims) prims = new Prims();
    @type({ map: Player }) players = new MapSchema<Player>();
    @type([Entity]) entities = new ArraySchema<Entity>();
    @type({ map: Entity }) byId = new MapSchema<Entity>();
    @type(Player) leader: Player;
    @type(Entity) target: Entity;
    @type(["string"]) tags = new ArraySchema<string>();
    @type({ map: "number" }) counters = new MapSchema<number>();
}

function makePlayer(name: string, items = 2) {
    const p = new Player();
    p.id = "id-" + name;
    p.name = name;
    p.pos.x = name.length;
    p.pos.y = name.length * 2;
    for (let i = 0; i < items; i++) p.items.set(`${name}-item${i}`, new Item(`item${i}`, i * 10));
    p.scores.push(1, 2, 3);
    p.inventory.push(new Item("inv0", 5), new Item("inv1", 6));
    return p;
}

function baseState() {
    const s = new State();
    s.prims.str = "hello";
    s.prims.num = 42;
    s.prims.flag = true;
    s.players.set("alice", makePlayer("alice"));
    s.players.set("bob", makePlayer("bob"));
    s.entities.push(makePlayer("carol", 1));
    const m = new Monster(); m.id = "m1"; m.hp = 100; m.pos.x = 5; m.pos.y = 6;
    s.entities.push(m);
    s.tags.push("a", "b");
    s.counters.set("k", 1);
    return s;
}

describe("v6 differential (v5 ≡ v6)", () => {

    it("1. primitives: every type, re-set, delete, delete+set, strings", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => {
            const p = st.prims;
            p.str = "x".repeat(200); p.num = -1; p.flag = false;
            p.i8 = -3; p.u8 = 250; p.i16 = -30000; p.u16 = 60000; p.i32 = -2_000_000_000; p.u32 = 4_000_000_000;
            p.i64 = 2 ** 40; p.u64 = 2 ** 41; p.f32 = 1.5; p.f64 = Math.PI; p.big = 123n; p.ubig = 456n;
        });
        tick(sides, (st) => { st.prims.num = -1; st.prims.str = "x".repeat(200); }); // same values → no change
        tick(sides, (st) => { st.prims.num = 300; st.prims.f64 = 0.1; st.prims.str = "ção 🎉"; st.prims.num = 3.25; });
        tick(sides, (st) => { st.prims.str = undefined; st.prims.flag = undefined; });
        tick(sides, (st) => { st.prims.str = undefined; st.prims.str = "back"; }); // DELETE then ADD same tick
        tick(sides, (st) => { st.prims.num = 0; st.prims.str = ""; st.prims.f32 = 0; });
        for (const len of [0, 31, 32, 127, 128]) tick(sides, (st) => { st.prims.str = "s".repeat(len); });
        report("primitives", sides);
    });

    it("2. nested instances: assign, replace, null, self-reassign", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.leader = makePlayer("dave"); });
        tick(sides, (st) => { st.leader.pos.x = 99; st.leader.equipped = new Item("sword", 7); });
        tick(sides, (st) => { st.leader = makePlayer("erin"); }); // DELETE_AND_ADD
        tick(sides, (st) => { st.leader.pos = new Vec(1, 2); st.leader.equipped = new Item("axe", 9); });
        tick(sides, (st) => { st.leader = undefined; });
        tick(sides, (st) => { st.leader = makePlayer("frank"); st.leader.equipped = new Item("bow", 3); st.leader.equipped.points.push(new Vec(1, 1)); });
        tick(sides, (st, side) => { side.ctx.l = st.leader; st.leader = undefined; st.leader = side.ctx.l; }); // self-reassign after delete
        tick(sides, (st) => { st.leader.equipped = undefined; });
        report("nested", sides);
    });

    it("3. instance sharing across fields and collections", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.leader = st.players.get("alice"); });
        tick(sides, (st) => { st.target = st.players.get("alice"); st.byId.set("alice", st.players.get("alice")); });
        tick(sides, (st) => { st.players.get("alice").pos.x = 123; });
        tick(sides, (st) => { st.leader = undefined; }); // count -1, still alive
        tick(sides, (st) => { st.byId.delete("alice"); });
        tick(sides, (st) => { st.players.delete("alice"); }); // still referenced by target
        tick(sides, (st) => { st.target.pos.y = 77; });
        tick(sides, (st) => { st.target = undefined; }); // last edge → GC
        // shared child: same Item in two players + same tick move
        tick(sides, (st) => { const it = new Item("shared", 1); st.players.get("bob").equipped = it; st.entities.push(makePlayer("gina", 0)); (st.entities.at(2) as Player).equipped = it; });
        tick(sides, (st) => { const bob = st.players.get("bob"); const it = bob.equipped; bob.equipped = undefined; st.leader = makePlayer("henry", 0); st.leader.equipped = it; });
        tick(sides, (st) => { st.leader.equipped.price = 55; });
        // late joiner sees the shared refs once
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.leader.equipped.price = 56; });
        report("sharing", sides);
    });

    it("4. polymorphism: subclass instances in fields, arrays and maps", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.target = st.entities.at(1); }); // Monster in an Entity field
        tick(sides, (st) => { const m = new Monster(); m.id = "m2"; m.hp = 5; st.byId.set("m2", m); st.byId.set("p", makePlayer("ivy", 0)); });
        tick(sides, (st) => { (st.entities.at(1) as Monster).hp = 50; (st.byId.get("p") as Player).name = "IVY"; });
        tick(sides, (st) => { const m = new Monster(); m.id = "m3"; m.hp = 1; st.target = m; }); // subtype → subtype replacement
        tick(sides, (st) => { st.entities.push(new Entity()); st.entities.at(2).id = "plain"; });
        sides.forEach((s) => join(s));
        tick(sides, (st) => { (st.target as Monster).hp = 2; });
        report("polymorphism", sides);
    });

    it("5. MapSchema: add/replace/delete/clear, re-add same tick, keys, growth, whole-map replacement", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.counters.set("a", 1); st.counters.set("k", 2); st.counters.delete("k"); });
        tick(sides, (st) => { st.counters.set("k", 3); st.counters.set("ção", 4); st.counters.set("123", 5); });
        tick(sides, (st) => { st.counters.delete("a"); st.counters.set("a", 6); }); // delete + re-add same tick
        tick(sides, (st) => { st.players.set("bob", makePlayer("bob2")); }); // DELETE_AND_ADD schema entry
        tick(sides, (st) => { st.players.get("bob").items.set("x", new Item("x", 1)); st.players.get("bob").items.delete("bob2-item0"); });
        tick(sides, (st) => { st.players.get("bob").items.clear(); });
        tick(sides, (st) => { st.players.get("bob").items.set("y", new Item("y", 2)); st.players.get("bob").items.clear(); st.players.get("bob").items.set("z", new Item("z", 3)); });
        tick(sides, (st) => { for (let i = 0; i < 300; i++) st.counters.set("c" + i, i); });
        tick(sides, (st) => { st.counters.set("c250", -250); st.counters.delete("c100"); });
        tick(sides, (st) => { st.players = new MapSchema<Player>(); st.players.set("new", makePlayer("new")); });
        tick(sides, (st) => { st.counters.clear(); });
        report("map", sides);
    });

    it("6. ArraySchema of primitives: every mutation", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.tags.push("c", "d"); });
        tick(sides, (st) => { st.tags.pop(); st.tags.unshift("z"); });
        tick(sides, (st) => { st.tags.shift(); st.tags.splice(1, 1); });
        tick(sides, (st) => { st.tags[0] = "A"; st.tags.push("e"); });
        tick(sides, (st) => { st.tags.reverse(); });
        tick(sides, (st) => { st.tags.push("m"); st.tags.reverse(); }); // reverse with pending ops
        tick(sides, (st) => { st.tags.sort(); });
        tick(sides, (st) => { st.tags.clear(); });
        tick(sides, (st) => { st.tags.push("q"); st.tags.shift(); st.tags.push("r"); }); // same tick push+shift
        tick(sides, (st) => { st.players.get("alice").scores.splice(0, 3, 9, 8); });
        tick(sides, (st) => { st.tags.length = 0; });
        report("array primitives", sides);
    });

    it("7. ArraySchema of Schema children: push/pop/shift/unshift/splice/move/reverse/sort/replace", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        const inv = (st: State) => st.players.get("alice").inventory;
        tick(sides, (st) => { inv(st).push(new Item("inv2", 7)); });
        tick(sides, (st) => { inv(st).pop(); inv(st).unshift(new Item("first", 0)); });
        tick(sides, (st) => { inv(st).shift(); inv(st).splice(1, 1); });
        tick(sides, (st) => { inv(st).push(new Item("a", 1), new Item("b", 2), new Item("c", 3)); });
        tick(sides, (st) => { inv(st).move((arr) => { const first = arr[0]; arr[0] = arr[2]; arr[2] = first; }); });
        tick(sides, (st) => { inv(st).reverse(); });
        tick(sides, (st) => { inv(st).push(new Item("d", 4)); inv(st).reverse(); }); // CLEAR + re-add path
        tick(sides, (st) => { inv(st).sort((a, b) => a.price - b.price); });
        tick(sides, (st) => { inv(st)[1] = new Item("replaced", 42); });
        tick(sides, (st) => { inv(st).at(0).price = 1000; inv(st).at(0).points.push(new Vec(3, 4)); });
        tick(sides, (st) => { inv(st).splice(0, 1); inv(st).push(new Item("e", 5)); });
        tick(sides, (st) => { const shared = inv(st).at(0); st.players.get("bob").inventory.push(shared); }); // same instance in two arrays
        tick(sides, (st) => { inv(st).splice(0, 1); }); // still alive via bob
        tick(sides, (st) => { st.players.get("bob").inventory.clear(); });
        tick(sides, (st) => { st.entities.splice(0, 1); st.entities.push(makePlayer("late", 1)); });
        tick(sides, (st) => { st.entities = new ArraySchema<Entity>(); st.entities.push(makePlayer("fresh", 1)); });
        report("array schema", sides);
    });

    it("10. join: late clients get the same snapshot", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.players.set("zed", makePlayer("zed")); st.leader = st.players.get("zed"); });
        sides.forEach((s) => join(s));
        tick(sides, (st) => { st.leader.pos.x = 1; });
        report("join", sides);
    });

    it("13. buffer overflow growth (tiny BUFFER_SIZE)", () => {
        const prev = Encoder.BUFFER_SIZE;
        Encoder.BUFFER_SIZE = 512;
        try {
            const sides = makeSides(baseState, { bufferSize: 512 });
            const cap = { allowWarnings: /buffer overflow/ };
            for (const s of sides) join(s);
            tick(sides, (st) => { for (let i = 0; i < 40; i++) st.players.set("p" + i, makePlayer("player" + i)); }, cap);
            tick(sides, (st) => { st.players.forEach((p) => { p.pos.x += 1; }); }, cap);
            for (const s of sides) join(s);
            tick(sides, (st) => { st.players.forEach((p) => { p.pos.y += 1; }); }, cap);
        } finally {
            Encoder.BUFFER_SIZE = prev;
        }
    });

    it("16. refId growth past 16 383 (multi-byte uvarint refIds, chunk len ≥ 128)", () => {
        const sides = makeSides(baseState);
        sides.forEach((s) => join(s));
        // burn refIds: each Vec allocates one
        tick(sides, (st) => { for (let i = 0; i < 6000; i++) { st.byId.set("t" + i, new Entity()); } }, { skipParity: true });
        tick(sides, (st) => { for (let i = 0; i < 6000; i++) st.byId.delete("t" + i); });
        tick(sides, (st) => { st.byId.set("big", makePlayer("big", 3)); }); // refIds > 16k now
        tick(sides, (st) => { const p = st.byId.get("big") as Player; p.pos.x = 5; p.name = "n".repeat(200); });
        sides.forEach((s) => join(s));
        report("refId growth", sides);
    });
});
