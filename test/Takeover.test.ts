import * as assert from "assert";
import { schema, t, Schema, Encoder, Decoder, Reflection, getDecoderStateCallbacks, $refId } from "../src";
import { assertOwnIds, assertRefParity, tick } from "./Schema";

const Item = schema({ name: t.string() }, "TItem");
const Weapon = Item.extend({ damage: t.uint8() }, "TWeapon");
const Player = schema({
    name: t.string(),
    x: t.number(),
    items: t.array(Item),
    tags: t.set("string"),
    main: Item,
}, "TPlayer");
const State = schema({
    players: t.map(Player),
    shared: Item,
    numbers: t.array("number"),
    tick: t.number(),
}, "TState");

const json = (s: any) => JSON.parse(JSON.stringify(s.toJSON()));

/** Peers that joined `host` through its full state (untyped: tests mutate `peer.state` freely). */
function join(host: Encoder, newRoot: () => Schema, count: number): Decoder<any>[] {
    return Array.from({ length: count }, () => {
        const decoder = new Decoder(newRoot());
        decoder.decode(host.encodeAll().slice());
        return decoder;
    });
}

/** Same state on every decoder and on a late joiner. */
function assertSameState(encoder: Encoder, ...decoders: Decoder[]) {
    const [late] = join(encoder, () => new State(), 1);
    for (const d of [...decoders, late]) assert.deepStrictEqual(json(d.state), json(encoder.state));
}

function assertInSync(encoder: Encoder, ...decoders: Decoder[]) {
    assertSameState(encoder, ...decoders);
    for (const d of decoders) assertRefParity(encoder.root, d.root);
}

/** Old host with some history (deletes, array ops), and peers that decoded its stream. */
function session(peerCount = 2, newRoot: () => Schema = () => new State()) {
    const state = new State();
    const host = new Encoder(state);
    for (const name of ["a", "b", "c", "gone"]) {
        state.players.set(name, new Player().assign({ name, x: 0, main: new Item().assign({ name: name + "-main" }) }));
    }
    state.shared = new Item().assign({ name: "shared" });
    state.players.get("a").items.push(new Item().assign({ name: "a0" }), state.shared);
    state.numbers.push(1, 2, 3);
    const peers = join(host, newRoot, peerCount);
    host.discardChanges();

    state.players.delete("gone");
    state.numbers.splice(1, 1);
    state.numbers.unshift(0);
    state.numbers.reverse();
    state.players.get("b").tags.add("red");
    state.players.get("a").items.push(new Item().assign({ name: "a1" }));
    tick(host, ...peers);
    state.players.get("a").items.shift();
    tick(host, ...peers);
    return { state, host, peers };
}

describe("Encoder.fromDecoder (takeover)", () => {
    it("peers keep their decoders: the new host's patches apply directly", () => {
        const { peers: [b, c] } = session();
        const enc = Encoder.fromDecoder(b);
        const s = b.state;
        assert.strictEqual(enc.encode().byteLength, 0, "nothing re-sent");

        s.players.get("a").x = 10;
        s.players.delete("c");
        s.players.set("d", new Player().assign({ name: "d", main: new Item().assign({ name: "d-main" }) }));
        s.players.get("a").items.push(new Item().assign({ name: "new" }));
        s.players.get("a").items.splice(0, 1);
        s.players.get("b").tags.add("blue");
        s.players.get("b").tags.delete("red");
        s.numbers.push(9);
        s.numbers.sort((x: number, y: number) => x - y);
        s.shared.name = "renamed";
        s.tick = 1;
        tick(enc, c);
        assertInSync(enc, c);

        s.players.get("d").items.push(s.shared);
        s.players.get("a").items.clear();
        s.numbers.reverse();
        tick(enc, c);
        assertInSync(enc, c);
    });

    it("resyncing an in-sync peer with the new host's snapshot fires no callbacks", () => {
        const { peers: [b, c] } = session();
        const $ = getDecoderStateCallbacks(c);
        let fired = 0;
        const s = c.state;
        $(s).players.onAdd(() => fired++, false);
        $(s).players.onRemove(() => fired++);
        $(s).numbers.onAdd(() => fired++, false);
        $(s).numbers.onRemove(() => fired++);
        $(s).listen("tick", () => fired++, false);
        for (const key of s.players.keys()) {
            $(s.players.get(key)).listen("x", () => fired++, false);
            $(s.players.get(key)).items.onAdd(() => fired++, false);
            $(s.players.get(key)).items.onRemove(() => fired++);
        }

        const enc = Encoder.fromDecoder(b);
        c.decodeResync(enc.encodeAll().slice());
        assert.strictEqual(fired, 0);
        assertInSync(enc, c);

        enc.discardChanges();
        b.state.players.get("a").x = 123;
        tick(enc, c);
        assert.strictEqual(fired, 1, "callbacks are wired");
    });

    it("existing instances and callbacks survive on peers", () => {
        const { peers: [b, c] } = session();
        const $ = getDecoderStateCallbacks(c);
        const added: string[] = [];
        const removed: string[] = [];
        $(c.state).players.onAdd((_p: any, key: string) => added.push(key), false);
        $(c.state).players.onRemove((_p: any, key: string) => removed.push(key));
        const aBefore = c.state.players.get("a");

        const enc = Encoder.fromDecoder(b);
        b.state.players.set("d", new Player().assign({ name: "d" }));
        b.state.players.delete("b");
        tick(enc, c);

        assert.deepStrictEqual(added, ["d"]);
        assert.deepStrictEqual(removed, ["b"]);
        assert.strictEqual(c.state.players.get("a"), aBefore);
    });

    it("new refs are numbered past every id the decoder saw, freed ones included", () => {
        const { host, peers: [b] } = session(1);
        const maxLive = Math.max(...b.root.refs.keys());
        Encoder.fromDecoder(b);
        const fresh = new Item().assign({ name: "fresh" });
        b.state.players.get("a").main = fresh;
        assert.ok(fresh[$refId] >= (host.root as any).nextUniqueId, `${fresh[$refId]} reuses an id of the old host`);
        assert.ok(fresh[$refId] > maxLive);
        assert.strictEqual(b.state[$refId], 0);
    });

    it("a lagging peer catches up with decodeResync, and freed ids aren't handed out again", () => {
        const { state, host, peers: [b, c] } = session();
        state.players.set("tmp", new Player().assign({ name: "tmp", main: new Item().assign({ name: "tmp-main" }) }));
        tick(host, b, c);
        // c misses this patch, which frees the highest ids
        state.players.delete("tmp");
        state.players.delete("a");
        state.players.get("b").x = 5;
        state.numbers.push(4);
        tick(host, b);

        const enc = Encoder.fromDecoder(b);
        const s = b.state;
        s.players.get("b").main = new Item().assign({ name: "fresh-main" });
        s.players.set("e", new Player().assign({ name: "e", items: [new Item().assign({ name: "e0" })] }));
        c.decodeResync(enc.encodeAll().slice());
        enc.discardChanges();
        assertSameState(enc, c); // no ref parity: decodeResync never releases b.main's replaced ref (with or without a takeover)
        s.players.get("e").items.at(0).name = "e0!";
        tick(enc, c);
        assertSameState(enc, c);
    });

    it("an instance attached locally before the takeover doesn't collide with decoded ids", () => {
        const { peers: [b, c] } = session();
        b.state.players.get("a").main = new Item().assign({ name: "local" }); // walked before player b's decoded refs
        const enc = Encoder.fromDecoder(b);
        assertOwnIds(enc);
        // the write itself was untracked (decoded instances record nothing): peers resync
        c.decodeResync(enc.encodeAll().slice());
        enc.discardChanges();
        assertSameState(enc, c); // no ref parity: decodeResync never releases a.main's replaced ref (with or without a takeover)
        b.state.players.get("a").main.name = "local!";
        tick(enc, c);
        assertSameState(enc, c);
    });

    it("an @unreliable field changed in the first tick rides the unreliable channel", () => {
        const Pos = schema({ x: t.number().unreliable(), label: t.string() }, "TPos");
        const Holder = schema({ pos: Pos }, "THolder");
        const host = new Encoder(new Holder().assign({ pos: new Pos().assign({ x: 1, label: "p" }) }));
        const [b, c] = join(host, () => new Holder(), 2);

        const enc = Encoder.fromDecoder(b);
        b.state.pos.x = 2;
        assert.strictEqual(enc.encode().byteLength, 0);
        c.decode(enc.encodeUnreliable().slice());
        assert.strictEqual(c.state.pos.x, 2);
    });

    it("a decoder-built root (initializeForDecoder) takes over the same way", () => {
        const { peers: [b, c] } = session(2, () => (State as any).initializeForDecoder());
        const enc = Encoder.fromDecoder(b);
        assert.strictEqual(enc.encode().byteLength, 0);
        b.state.players.get("a").x = 3;
        b.state.tick = 2;
        tick(enc, c);
        assertInSync(enc, c);
    });

    it("subclass type ids carry over (polymorphic refs)", () => {
        const Bag = schema({ items: t.map(Item) }, "TBag");
        const up = new Bag();
        up.items.set("w", new Weapon().assign({ name: "sword", damage: 5 }));
        const [b, c] = join(new Encoder(up), () => new Bag(), 2);

        const enc = Encoder.fromDecoder(b);
        b.state.items.set("w2", new Weapon().assign({ name: "axe", damage: 9 }));
        tick(enc, c);
        assert.ok(c.state.items.get("w2") instanceof Weapon);
        assert.deepStrictEqual(json(c.state), json(b.state));
    });

    it("a peer that decoded through Reflection (no classes) takes over", () => {
        const Bag = schema({ items: t.map(Item), n: t.number() }, "TBag2");
        const up = new Bag();
        up.items.set("w", new Weapon().assign({ name: "sword", damage: 5 }));
        const host = new Encoder(up);
        const handshake = Reflection.encode(host).slice();
        const full = host.encodeAll().slice();
        const b = Reflection.decode<any>(handshake), c = Reflection.decode<any>(handshake);
        b.decode(full); c.decode(full);

        const types: any = b.context.types;
        for (const id in types) Reflection.makeEncodable(types[id]);
        const enc = Encoder.fromDecoder(b);
        const s = b.state;
        const WeaponR = s.items.get("w").constructor;
        s.items.set("w2", new WeaponR().assign({ name: "axe", damage: 9 }));
        s.n = 1;
        tick(enc, c);
        assert.strictEqual(c.state.items.get("w2").constructor.name, c.state.items.get("w").constructor.name);
        assert.deepStrictEqual(json(c.state), json(b.state));
    });

    it("chained takeovers: b, then c, then d", () => {
        const { peers: [b, c, d] } = session(3);
        const encB = Encoder.fromDecoder(b);
        b.state.players.set("b2", new Player().assign({ name: "b2" }));
        tick(encB, c, d);

        const encC = Encoder.fromDecoder(c);
        c.state.players.get("b2").items.push(new Item().assign({ name: "c-item" }));
        c.state.numbers.push(7);
        tick(encC, d);
        assertInSync(encC, d);

        const encD = Encoder.fromDecoder(d);
        const [late] = join(encD, () => new State(), 1);
        encD.discardChanges();
        d.state.players.delete("b2");
        tick(encD, late);
        assertInSync(encD, late);
    });

    it("the decoder can no longer decode into the taken-over state", () => {
        const { state, host, peers: [b] } = session(1);
        Encoder.fromDecoder(b);
        state.players.get("a").x = 1;
        assert.throws(() => b.decode(host.encode()), /cannot decode into an instance attached to an Encoder/);
    });

    it("plain new Encoder(decodedState) still allocates its own ids", () => {
        const { peers: [b] } = session(1);
        const ids = [...b.root.refs.keys()];
        const enc = new Encoder(b.state);
        const third = new Decoder(new State());
        third.decode(enc.encode().slice()); // the first encode() carries everything
        assert.deepStrictEqual(json(third.state), json(b.state));
        assert.notDeepStrictEqual([...enc.root.changeTrees.keys()], ids);
    });
});
