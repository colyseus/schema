import * as assert from "assert";
import { Schema, schema, t, type, ArraySchema, StateView } from "../src";
import { getEncoder, getDecoder, createInstanceFromReflection } from "./Schema";

describe("@static modifier (sync-once, skip change tracking)", () => {

    it("a static primitive field appears in encodeAll but NOT in per-tick encode", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");

        const state = new State();
        const encoder = getEncoder(state);

        (state as any).dynamic = "hello";
        (state as any).config = 42;

        // Per-tick encode: only `dynamic`
        const tickDecoded = createInstanceFromReflection(state);
        getDecoder(tickDecoded).decode(encoder.encode());
        assert.strictEqual((tickDecoded as any).dynamic, "hello");
        assert.strictEqual((tickDecoded as any).config, undefined,
            "@static field must not be emitted on per-tick encode");

        // Full-sync: includes `config`
        const fullDecoded = createInstanceFromReflection(state);
        getDecoder(fullDecoded).decode(encoder.encodeAll());
        assert.strictEqual((fullDecoded as any).dynamic, "hello");
        assert.strictEqual((fullDecoded as any).config, 42);

        encoder.discardChanges();
    });

    it("mutations on a static field after initial encode are silently ignored for tick patches", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");

        const state = new State();
        const encoder = getEncoder(state);

        (state as any).dynamic = "v1";
        (state as any).config = 100;

        // Bootstrap
        const client = createInstanceFromReflection(state);
        getDecoder(client).decode(encoder.encodeAll());
        encoder.discardChanges();
        assert.strictEqual((client as any).config, 100);

        // Mutate both fields, re-encode tick
        (state as any).dynamic = "v2";
        (state as any).config = 200; // should be silently skipped

        const tickBytes = encoder.encode();
        getDecoder(client).decode(tickBytes);
        assert.strictEqual((client as any).dynamic, "v2");
        assert.strictEqual((client as any).config, 100,
            "mutations on a @static field must not propagate on tick patches");

        encoder.discardChanges();
    });

    it("a LATE-joining client sees the latest static value via encodeAll", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");

        const state = new State();
        const encoder = getEncoder(state);

        (state as any).dynamic = "v1";
        (state as any).config = 100;

        encoder.encode();
        encoder.discardChanges();

        // Server mutates config; existing clients won't see it, but a late
        // joiner running encodeAll should receive the new value.
        (state as any).config = 999;

        const lateJoiner = createInstanceFromReflection(state);
        getDecoder(lateJoiner).decode(encoder.encodeAll());
        assert.strictEqual((lateJoiner as any).config, 999);

        encoder.discardChanges();
    });

    it("static collections skip tracking for their items", () => {
        class Item extends Schema {
            @type("number") value: number;
        }
        const State = schema({
            dynamic: t.string(),
            items: t.array(Item).static(),
        }, "State");

        const state = new State();
        const encoder = getEncoder(state);

        (state as any).dynamic = "v";
        const items = (state as any).items as ArraySchema<Item>;
        items.push(new Item().assign({ value: 1 }) as any);
        items.push(new Item().assign({ value: 2 }) as any);

        // Per-tick: items are static → not emitted
        const tickDecoded = createInstanceFromReflection(state);
        getDecoder(tickDecoded).decode(encoder.encode());
        assert.strictEqual((tickDecoded as any).dynamic, "v");
        assert.strictEqual((tickDecoded as any).items?.length ?? 0, 0);

        // Full-sync: items are emitted
        const fullDecoded = createInstanceFromReflection(state);
        getDecoder(fullDecoded).decode(encoder.encodeAll());
        assert.strictEqual((fullDecoded as any).items.length, 2);
        assert.strictEqual((fullDecoded as any).items[0].value, 1);
        assert.strictEqual((fullDecoded as any).items[1].value, 2);

        encoder.discardChanges();
    });

    it("static Schema sub-tree: mutations on child fields are NOT propagated", () => {
        const Config = schema({
            maxPlayers: t.number(),
            mapName: t.string(),
        }, "Config");
        const State = schema({
            dynamic: t.string(),
            config: t.ref(Config).static(),
        }, "State");

        const state = new State();
        const encoder = getEncoder(state);

        const cfg = new Config();
        (cfg as any).maxPlayers = 4;
        (cfg as any).mapName = "arena";
        (state as any).dynamic = "hi";
        (state as any).config = cfg;

        // Bootstrap client
        const client = createInstanceFromReflection(state);
        getDecoder(client).decode(encoder.encodeAll());
        encoder.discardChanges();
        assert.strictEqual((client as any).config.maxPlayers, 4);

        // Mutate a sub-field on the static Config
        (cfg as any).maxPlayers = 16;

        // Per-tick encode: mutation NOT propagated
        const tickBytes = encoder.encode();
        getDecoder(client).decode(tickBytes);
        assert.strictEqual((client as any).config.maxPlayers, 4,
            "mutations on fields of a @static sub-tree must NOT propagate on tick");

        // encodeAll for new joiner: DOES see the new value
        const lateJoiner = createInstanceFromReflection(state);
        getDecoder(lateJoiner).decode(encoder.encodeAll());
        assert.strictEqual((lateJoiner as any).config.maxPlayers, 16);

        encoder.discardChanges();
    });

    it("isFieldStatic classification: per-field + inherited", () => {
        const Config = schema({ x: t.number() }, "Config");
        const State = schema({
            a: t.number(),
            b: t.number().static(),
            c: t.ref(Config).static(),
        }, "State");

        const state = new State();
        // Attaching an encoder triggers setRoot → checkIsFiltered → inherited
        // flag plumbing on child instances.
        getEncoder(state);
        (state as any).a = 1;
        (state as any).b = 2;
        const cfg = new Config();
        (state as any).c = cfg;

        const changes: any = (state as any)["~changes"];
        assert.strictEqual(changes.isFieldStatic(0), false);
        assert.strictEqual(changes.isFieldStatic(1), true);
        assert.strictEqual(changes.isFieldStatic(2), true);
        // child inherits isStatic
        const cfgChanges: any = (cfg as any)["~changes"];
        assert.strictEqual(cfgChanges.isStatic, true);
        assert.strictEqual(cfgChanges.isFieldStatic(0), true);
    });

});
