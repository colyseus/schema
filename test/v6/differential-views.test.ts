import * as assert from "assert";
import { Schema, type, view, MapSchema, ArraySchema } from "../../src";
import { makeSides, join, tick, offline, resync, report } from "./harness";

const TAG_A = 1, TAG_B = 2;

class Vec extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}
class Item extends Schema {
    @type("string") name: string;
    @view() @type("number") secretPrice: number;
}
class Player extends Schema {
    @type("string") name: string;
    @type(Vec) pos = new Vec();
    @view() @type("number") privateGold: number;
    @view(TAG_A) @type("string") tagA: string;
    @view(TAG_B) @type("string") tagB: string;
    @view() @type(Item) secretItem: Item;
    @type({ map: Item }) items = new MapSchema<Item>();
}
class State extends Schema {
    @type("string") turn: string;
    @view() @type("string") secret: string;
    @type({ map: Player }) players = new MapSchema<Player>();
    @view() @type({ map: Player }) hidden = new MapSchema<Player>();
    @view() @type([Player]) squad = new ArraySchema<Player>();
    @type([Player]) roster = new ArraySchema<Player>();
}

function makePlayer(name: string) {
    const p = new Player();
    p.name = name; p.pos.x = 1; p.pos.y = 2; p.privateGold = name.length; p.tagA = "A-" + name; p.tagB = "B-" + name;
    p.items.set("i0", Object.assign(new Item(), { name: "i0", secretPrice: 10 }));
    return p;
}
function base() {
    const s = new State();
    s.turn = "p1"; s.secret = "s3cret";
    s.players.set("alice", makePlayer("alice"));
    s.players.set("bob", makePlayer("bob"));
    s.hidden.set("h1", makePlayer("h1"));
    s.hidden.set("h2", makePlayer("h2"));
    s.squad.push(makePlayer("sq1"), makePlayer("sq2"));
    s.roster.push(makePlayer("r1"));
    return s;
}

describe("v6 differential — views", () => {

    it("8. tagged fields: root + nested, default and custom tags, remove/re-add", () => {
        const sides = makeSides(base);
        sides.forEach((s) => join(s)); // c0: no view
        sides.forEach((s) => join(s, (v, st) => { v.add(st); v.add(st.players.get("alice")); })); // c1: root secret + alice's default-tag fields
        sides.forEach((s) => join(s, (v, st) => { v.add(st.players.get("alice"), TAG_A); })); // c2: alice with TAG_A
        sides.forEach((s) => join(s, (v, st) => { v.add(st.players.get("bob"), TAG_A | TAG_B); })); // c3: bob with both
        tick(sides, (st) => { st.secret = "changed"; st.turn = "p2"; });
        tick(sides, (st) => { const a = st.players.get("alice"); a.privateGold = 99; a.tagA = "A2"; a.tagB = "B2"; a.pos.x = 5; });
        tick(sides, (st) => { const b = st.players.get("bob"); b.privateGold = 7; b.tagA = "A3"; b.tagB = "B3"; });
        tick(sides, (st) => { st.players.get("alice").secretItem = Object.assign(new Item(), { name: "si", secretPrice: 3 }); });
        tick(sides, (st) => { st.players.get("alice").secretItem.secretPrice = 4; st.players.get("alice").items.get("i0").secretPrice = 11; });
        tick(sides, (st, side) => { side.clients[1].view!.remove(st.players.get("alice")); });
        tick(sides, (st) => { st.players.get("alice").privateGold = 100; });
        tick(sides, (st, side) => { side.clients[1].view!.add(st.players.get("alice")); });
        tick(sides, (st, side) => { side.clients[2].view!.add(st.players.get("alice"), TAG_B); });
        tick(sides, (st) => { st.players.get("alice").tagB = "B4"; });
        tick(sides, (st, side) => { side.clients[3].view!.remove(st.players.get("bob"), TAG_A); });
        tick(sides, (st) => { st.players.get("bob").tagA = "A5"; st.players.get("bob").tagB = "B5"; });
        report("tagged", sides);
    });

    it("9. filtered map / array under views: bootstrap, remove, same-tick add+remove, nested mutation, array ops", () => {
        const sides = makeSides(base);
        sides.forEach((s) => join(s));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h1")); }));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.squad.at(0)); }));
        tick(sides, (st) => { st.hidden.get("h1").pos.x = 10; st.hidden.get("h2").pos.x = 20; });
        tick(sides, (st, side) => { side.clients[1].view!.add(st.hidden.get("h2")); }); // bootstrap of an existing instance
        tick(sides, (st) => { st.hidden.get("h2").pos.y = 21; st.hidden.get("h2").items.set("n", Object.assign(new Item(), { name: "n", secretPrice: 1 })); });
        tick(sides, (st, side) => { side.clients[1].view!.remove(st.hidden.get("h1")); });
        tick(sides, (st) => { st.hidden.get("h1").pos.x = 11; });
        tick(sides, (st, side) => { const p = makePlayer("h3"); st.hidden.set("h3", p); side.clients[1].view!.add(p); }); // new + add same tick
        tick(sides, (st, side) => { const p = makePlayer("h4"); st.hidden.set("h4", p); side.clients[1].view!.add(p); side.clients[1].view!.remove(p); });
        tick(sides, (st, side) => { side.clients[1].view!.add(st.hidden.get("h4")); st.hidden.delete("h4"); }); // add + state removal same tick
        tick(sides, (st) => { st.hidden.delete("h3"); });
        // filtered array
        tick(sides, (st, side) => { side.clients[2].view!.add(st.squad.at(1)); });
        tick(sides, (st) => { st.squad.at(1).pos.x = 33; });
        tick(sides, (st, side) => { const p = makePlayer("sq3"); st.squad.push(p); side.clients[2].view!.add(p); });
        tick(sides, (st) => { st.squad.splice(0, 1); });
        tick(sides, (st, side) => { side.clients[2].view!.remove(st.squad.at(0)); });
        tick(sides, (st) => { st.squad.at(0).pos.y = 44; st.squad.at(1).pos.y = 45; });
        tick(sides, (st, side) => { const p = makePlayer("sq4"); st.squad.unshift(p); side.clients[2].view!.add(p); });
        tick(sides, (st) => { st.squad.at(0).name = "renamed"; });
        tick(sides, (st) => { st.squad.clear(); });
        // late joiner with view onto filtered collections
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h2")); }));
        tick(sides, (st) => { st.hidden.get("h2").pos.x = 22; });
        report("filtered", sides);
    });

    it("12. three views, shared mutation + per-view fields + membership churn in one tick", () => {
        const sides = makeSides(base);
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h1")); }));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h2")); }));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h1")); v.add(st.hidden.get("h2")); }));
        tick(sides, (st, side) => {
            st.turn = "x";
            st.hidden.get("h1").privateGold = 1;
            st.hidden.get("h2").privateGold = 2;
            side.clients[0].view!.add(st.hidden.get("h2"));
            side.clients[1].view!.remove(st.hidden.get("h2"));
            const p = makePlayer("h9"); st.hidden.set("h9", p); side.clients[2].view!.add(p);
        });
        tick(sides, (st) => { st.hidden.forEach((p) => { p.pos.x += 1; p.privateGold += 1; }); });
        report("multi-view", sides);
    });

    it("11. late-join resync over an existing tree (collection deletes, re-keys, view removes while offline)", () => {
        const sides = makeSides(base);
        sides.forEach((s) => join(s));
        sides.forEach((s) => join(s, (v, st) => { v.add(st.hidden.get("h1")); v.add(st.squad.at(0)); }));
        tick(sides, (st) => { st.players.set("carol", makePlayer("carol")); });
        offline(sides, (st, side) => {
            st.players.delete("alice");
            st.players.get("bob").items.delete("i0");
            st.roster.splice(0, 1);
            st.roster.push(makePlayer("r2"));
            st.hidden.get("h1").pos.x = 50;
            side.clients[1].view!.remove(st.squad.at(0));
            side.clients[1].view!.add(st.hidden.get("h2"));
            st.players.set("bob", makePlayer("bob-new")); // instance replaced at a key
            st.turn = "resynced";
        });
        resync(sides);
        tick(sides, (st) => { st.players.get("bob").pos.x = 3; st.hidden.get("h2").privateGold = 9; });
        offline(sides, (st) => { st.players.get("carol").items.clear(); st.squad.push(makePlayer("sq5")); });
        resync(sides);
        tick(sides, (st) => { st.turn = "after"; });
        report("resync", sides);
    });
});
