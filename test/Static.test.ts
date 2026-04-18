import * as assert from "assert";
import { $changes, Schema, schema, t, type, ArraySchema, SchemaType } from "../src";
import { getEncoder, getDecoder, createInstanceFromReflection } from "./Schema";

describe("@static modifier (sync-once, skip change tracking)", () => {

    it("a static primitive field appears in encodeAll but NOT in per-tick encode", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");
        type State = SchemaType<typeof State>;

        const state = new State();
        const encoder = getEncoder(state);

        state.dynamic = "hello";
        state.config = 42;

        // Per-tick encode: only `dynamic`
        const tickDecoded = createInstanceFromReflection(state) as State;
        getDecoder(tickDecoded).decode(encoder.encode());
        assert.strictEqual(tickDecoded.dynamic, "hello");
        assert.strictEqual(tickDecoded.config, undefined,
            "@static field must not be emitted on per-tick encode");

        // Full-sync: includes `config`
        const fullDecoded = createInstanceFromReflection(state) as State;
        getDecoder(fullDecoded).decode(encoder.encodeAll());
        assert.strictEqual(fullDecoded.dynamic, "hello");
        assert.strictEqual(fullDecoded.config, 42);

        encoder.discardChanges();
    });

    it("mutations on a static field after initial encode are silently ignored for tick patches", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");
        type State = SchemaType<typeof State>;

        const state = new State();
        const encoder = getEncoder(state);

        state.dynamic = "v1";
        state.config = 100;

        // Bootstrap
        const client = createInstanceFromReflection(state) as State;
        getDecoder(client).decode(encoder.encodeAll());
        encoder.discardChanges();
        assert.strictEqual(client.config, 100);

        // Mutate both fields, re-encode tick
        state.dynamic = "v2";
        state.config = 200; // should be silently skipped

        const tickBytes = encoder.encode();
        getDecoder(client).decode(tickBytes);
        assert.strictEqual(client.dynamic, "v2");
        assert.strictEqual(client.config, 100,
            "mutations on a @static field must not propagate on tick patches");

        encoder.discardChanges();
    });

    it("a LATE-joining client sees the latest static value via encodeAll", () => {
        const State = schema({
            dynamic: t.string(),
            config: t.number().static(),
        }, "State");
        type State = SchemaType<typeof State>;

        const state = new State();
        const encoder = getEncoder(state);

        state.dynamic = "v1";
        state.config = 100;

        encoder.encode();
        encoder.discardChanges();

        // Server mutates config; existing clients won't see it, but a late
        // joiner running encodeAll should receive the new value.
        state.config = 999;

        const lateJoiner = createInstanceFromReflection(state) as State;
        getDecoder(lateJoiner).decode(encoder.encodeAll());
        assert.strictEqual(lateJoiner.config, 999);

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
        type State = SchemaType<typeof State>;

        const state = new State();
        const encoder = getEncoder(state);

        state.dynamic = "v";
        state.items.push(new Item().assign({ value: 1 }));
        state.items.push(new Item().assign({ value: 2 }));

        // Per-tick: items are static → not emitted
        const tickDecoded = createInstanceFromReflection(state) as State;
        getDecoder(tickDecoded).decode(encoder.encode());
        assert.strictEqual(tickDecoded.dynamic, "v");
        assert.strictEqual(tickDecoded.items?.length ?? 0, 0);

        // Full-sync: items are emitted
        const fullDecoded = createInstanceFromReflection(state) as State;
        getDecoder(fullDecoded).decode(encoder.encodeAll());
        assert.strictEqual(fullDecoded.items.length, 2);
        assert.strictEqual(fullDecoded.items[0].value, 1);
        assert.strictEqual(fullDecoded.items[1].value, 2);

        encoder.discardChanges();
    });

    it("static Schema sub-tree: mutations on child fields are NOT propagated", () => {
        const Config = schema({
            maxPlayers: t.number(),
            mapName: t.string(),
        }, "Config");
        type Config = SchemaType<typeof Config>;

        const State = schema({
            dynamic: t.string(),
            config: t.ref(Config).static(),
        }, "State");
        type State = SchemaType<typeof State>;

        const state = new State();
        const encoder = getEncoder(state);

        const cfg = new Config();
        cfg.maxPlayers = 4;
        cfg.mapName = "arena";
        state.dynamic = "hi";
        state.config = cfg;

        // Bootstrap client
        const client = createInstanceFromReflection(state) as State;
        getDecoder(client).decode(encoder.encodeAll());
        encoder.discardChanges();
        assert.strictEqual(client.config.maxPlayers, 4);

        // Mutate a sub-field on the static Config
        cfg.maxPlayers = 16;

        // Per-tick encode: mutation NOT propagated
        const tickBytes = encoder.encode();
        getDecoder(client).decode(tickBytes);
        assert.strictEqual(client.config.maxPlayers, 4,
            "mutations on fields of a @static sub-tree must NOT propagate on tick");

        // encodeAll for new joiner: DOES see the new value
        const lateJoiner = createInstanceFromReflection(state) as State;
        getDecoder(lateJoiner).decode(encoder.encodeAll());
        assert.strictEqual(lateJoiner.config.maxPlayers, 16);

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
        state.a = 1;
        state.b = 2;
        const cfg = new Config();
        state.c = cfg;

        const changes: any = (state as any)[$changes];
        assert.strictEqual(changes.isFieldStatic(0), false);
        assert.strictEqual(changes.isFieldStatic(1), true);
        assert.strictEqual(changes.isFieldStatic(2), true);
        // child inherits isStatic
        const cfgChanges: any = (cfg as any)[$changes];
        assert.strictEqual(cfgChanges.isStatic, true);
        assert.strictEqual(cfgChanges.isFieldStatic(0), true);
    });

    // The encoder caches a per-class `staticBitmask` covering field indexes
    // 0–31 only (matches the existing filterBitmask limitation). Fields ≥32
    // fall back to `Metadata.hasStaticAtIndex`. This test exercises both
    // paths and verifies the per-tick / encodeAll routing still works
    // end-to-end.
    it("classification + routing works for @static fields at index ≥32 (bitmask fallback)", () => {
        // 34 fields. Index 5 (low — bitmask) and index 33 (high — fallback)
        // are @static; the rest are dynamic.
        const fields: Record<string, any> = {};
        for (let i = 0; i < 34; i++) {
            if (i === 5 || i === 33) {
                fields[`f${i}`] = t.number().static();
            } else {
                fields[`f${i}`] = t.number();
            }
        }
        const State = schema(fields, "WideStatic");

        const state = new State() as any;
        const encoder = getEncoder(state);
        const ct: any = state[$changes];

        // Spot-check classification across both paths.
        assert.strictEqual(ct.isFieldStatic(0), false, "dynamic field 0");
        assert.strictEqual(ct.isFieldStatic(5), true, "bitmask path: index 5");
        assert.strictEqual(ct.isFieldStatic(31), false, "bitmask boundary (31): dynamic");
        assert.strictEqual(ct.isFieldStatic(32), false, "fallback boundary (32): dynamic");
        assert.strictEqual(ct.isFieldStatic(33), true, "fallback path: index 33");

        // Routing: set initial values for everyone, encode tick + full sync.
        state.f0 = 100;   // dynamic
        state.f5 = 50;    // static via bitmask
        state.f33 = 33;   // static via fallback

        // Per-tick: only the dynamic field appears.
        const tickDecoded = createInstanceFromReflection(state) as any;
        getDecoder(tickDecoded).decode(encoder.encode());
        assert.strictEqual(tickDecoded.f0, 100, "dynamic field on tick");
        assert.strictEqual(tickDecoded.f5, undefined, "static (bitmask) NOT on tick");
        assert.strictEqual(tickDecoded.f33, undefined, "static (fallback) NOT on tick");

        // Full-sync: all three appear.
        const fullDecoded = createInstanceFromReflection(state) as any;
        getDecoder(fullDecoded).decode(encoder.encodeAll());
        assert.strictEqual(fullDecoded.f0, 100, "dynamic field on encodeAll");
        assert.strictEqual(fullDecoded.f5, 50, "static (bitmask) on encodeAll");
        assert.strictEqual(fullDecoded.f33, 33, "static (fallback) on encodeAll");

        // Post-init mutations on @static fields are silently dropped — verify
        // both bitmask + fallback paths obey this rule.
        encoder.discardChanges();
        state.f0 = 999;
        state.f5 = 999;
        state.f33 = 999;
        const tickAfterMutation = createInstanceFromReflection(state) as any;
        getDecoder(tickAfterMutation).decode(encoder.encode());
        assert.strictEqual(tickAfterMutation.f0, 999, "dynamic mutation appears");
        assert.strictEqual(tickAfterMutation.f5, undefined, "static (bitmask) mutation dropped");
        assert.strictEqual(tickAfterMutation.f33, undefined, "static (fallback) mutation dropped");

        encoder.discardChanges();
    });

});
