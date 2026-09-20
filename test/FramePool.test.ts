import * as assert from "assert";
import { Schema, MapSchema, type, Encoder } from "../src";
import { frameAt, passFrame } from "../src/encoder/EncodeOperation";

// The encoder's per-depth frames are module-global. After `discardChanges()`
// they must hold no reference into the encoded state (a disposed room must
// be collectable) while keeping their scratch arrays' backing store (a
// `length = 0` truncation would make V8 reallocate them on the next body).
describe("EncodeOperation frame pool", () => {
    class Item extends Schema {
        @type("string") name: string;
        @type("number") qty: number;
    }
    class State extends Schema {
        @type("number") tick: number = 0;
        @type({ map: Item }) items = new MapSchema<Item>();
    }

    function tickWithBody(encoder: Encoder<State>, state: State, n: number) {
        for (let i = 0; i < n; i++) state.items.set(`k${i}`, new Item().assign({ name: `item${i}`, qty: i }));
        encoder.encode();
    }

    it("releases scratch entries up to the high-water mark and keeps the backing store", () => {
        const state = new State();
        const encoder = new Encoder(state);
        encoder.encodeAll();
        encoder.discardChanges();

        // a fresh Item's body is written on frame 1; the map's ADD op stays on frame 0
        tickWithBody(encoder, state, 3);
        const body = frameAt(1);
        assert.ok(body.valsLen > 0, "the body frame recorded its scratch use");
        assert.strictEqual(passFrame().valsLen, 0, "the pass frame wrote no body");

        encoder.discardChanges();
        for (const f of [passFrame(), body]) {
            assert.strictEqual(f.tree, undefined);
            assert.strictEqual(f.ref, undefined);
            assert.strictEqual(f.refTarget, undefined);
            assert.strictEqual(f.values, undefined);
            assert.strictEqual(f.valsLen, 0);
            assert.strictEqual(f.strsLen, 0);
            assert.ok(f.vals.every((v) => v === undefined), "no value survives the release");
            assert.ok(f.strs.every((v) => v === undefined), "no map key survives the release");
        }
        assert.ok(body.vals.length > 0, "the scratch array kept its backing store");
    });

    it("releases the deeper frames of a full sync as well", () => {
        const state = new State();
        for (let i = 0; i < 4; i++) state.items.set(`k${i}`, new Item().assign({ name: `item${i}`, qty: i }));
        const encoder = new Encoder(state);

        // encodeAll: State on frame 0, the (unfiltered, streamed) map body on
        // frame 1, each Item's live body on frame 2 — and encodeAll releases
        // the frames itself (Reflection's throwaway encoder never discards)
        encoder.encodeAll();
        const itemBody = frameAt(2);
        assert.strictEqual(itemBody.valsLen, 0);
        assert.strictEqual(itemBody.tree, undefined);
        assert.ok(itemBody.vals.every((v) => v === undefined));
        assert.ok(itemBody.vals.length >= 2, "the two-field body left its backing store in place");
        assert.strictEqual(frameAt(1).valsLen, 0, "an unfiltered map body streams without scratch");
    });
});
