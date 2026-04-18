import * as assert from "assert";
import { $changes, Schema, schema, t, type, unreliable, transient, view, ArraySchema, MapSchema, StateView } from "../src";
import { Encoder } from "../src/encoder/Encoder";
import { Decoder } from "../src/decoder/Decoder";
import { createInstanceFromReflection, getEncoder, getDecoder } from "./Schema";

describe("@unreliable and @transient", () => {

    describe("@unreliable routing", () => {
        it("unreliable field mutations do NOT appear in the reliable encode() output", () => {
            class State extends Schema {
                @type("string") reliable: string;
                @unreliable @type("number") x: number;
            }

            const state = new State();
            const encoder = getEncoder(state);
            const decoded = createInstanceFromReflection(state) as State;
            const decoder = getDecoder(decoded);

            state.reliable = "hello";
            state.x = 7;

            const reliableBytes = encoder.encode();
            decoder.decode(reliableBytes);
            assert.strictEqual((decoder.state as any).reliable, "hello");
            assert.strictEqual((decoder.state as any).x, undefined,
                "unreliable field must not appear on reliable channel");

            // unreliable encode delivers it
            const unreliableBytes = encoder.encodeUnreliable();
            assert.ok(unreliableBytes.length > 0, "unreliable encode should have emitted the x field");
            decoder.decode(unreliableBytes);
            assert.strictEqual((decoder.state as any).x, 7);

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });

        it("mixed reliable + unreliable mutations route to the correct channel", () => {
            class State extends Schema {
                @type("string") name: string;
                @unreliable @type("number") x: number;
            }

            const state = new State();
            const encoder = getEncoder(state);
            const decoded = createInstanceFromReflection(state) as State;
            const decoder = getDecoder(decoded);

            state.name = "Alice";
            state.x = 42;

            // Reliable only
            decoder.decode(encoder.encode());
            assert.strictEqual((decoder.state as any).name, "Alice");
            assert.strictEqual((decoder.state as any).x, undefined);

            // Unreliable only
            decoder.decode(encoder.encodeUnreliable());
            assert.strictEqual((decoder.state as any).x, 42);

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });

        it("per-field @unreliable on collection items routes their values via the unreliable channel", () => {
            // The strict rule (@unreliable on primitives only) means the
            // ARRAY itself and its STRUCTURAL push entries flow on the
            // reliable channel — the decoder always learns the items'
            // refIds. Each item's x/y mutations route unreliable per the
            // per-field @unreliable annotation on Position.
            class Position extends Schema {
                @unreliable @type("number") x: number;
                @unreliable @type("number") y: number;
            }
            class State extends Schema {
                @type("string") name: string;
                @type([Position]) positions = new ArraySchema<Position>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            state.name = "world";
            state.positions.push(new Position().assign({ x: 1, y: 2 }));
            state.positions.push(new Position().assign({ x: 3, y: 4 }));

            // Reliable encode: name + array structure (length 2, item refIds
            // established) but the @unreliable x/y values are NOT here.
            const decoded = createInstanceFromReflection(state) as State;
            const decoder = getDecoder(decoded);
            decoder.decode(encoder.encode());
            assert.strictEqual((decoder.state as any).name, "world");
            assert.strictEqual((decoder.state as any).positions.length, 2,
                "structural push must arrive on reliable channel");
            assert.strictEqual((decoder.state as any).positions[0].x, undefined,
                "@unreliable x must NOT have arrived via reliable channel");

            // Unreliable encode: x/y values for the already-established items.
            decoder.decode(encoder.encodeUnreliable());
            assert.strictEqual((decoder.state as any).positions[0].x, 1);
            assert.strictEqual((decoder.state as any).positions[0].y, 2);
            assert.strictEqual((decoder.state as any).positions[1].x, 3);
            assert.strictEqual((decoder.state as any).positions[1].y, 4);

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });

        it("unreliable encodes can run at a different cadence than reliable", () => {
            class State extends Schema {
                @type("string") name: string;
                @unreliable @type("number") tick: number;
            }

            const state = new State();
            const encoder = getEncoder(state);
            const decoded = createInstanceFromReflection(state) as State;
            const decoder = getDecoder(decoded);

            state.name = "game";
            state.tick = 0;

            // First reliable encode: carries name
            decoder.decode(encoder.encode());
            assert.strictEqual((decoder.state as any).name, "game");
            encoder.discardChanges();

            // Multiple unreliable encodes between reliable encodes
            for (let i = 1; i <= 5; i++) {
                state.tick = i;
                decoder.decode(encoder.encodeUnreliable());
                encoder.discardUnreliableChanges();
                assert.strictEqual((decoder.state as any).tick, i);
            }

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });
    });

    describe("@transient exclusion from full-sync", () => {
        it("transient fields appear on tick patches but NOT in encodeAll output", () => {
            class State extends Schema {
                @type("string") persistent: string = "kept";
                @transient @type("number") ephemeral: number = 99;
            }

            const state = new State();
            const encoder = getEncoder(state);

            // Late-joining client: only encodeAll
            const fresh = createInstanceFromReflection(state);
            fresh.decode(encoder.encodeAll());
            assert.strictEqual((fresh as any).persistent, "kept");
            assert.strictEqual((fresh as any).ephemeral, undefined,
                "transient field must be absent from encodeAll snapshot");

            // Tick-connected client: gets ephemeral via encode()
            const tick = createInstanceFromReflection(state);
            tick.decode(encoder.encode());
            assert.strictEqual((tick as any).ephemeral, 99);

            encoder.discardChanges();
        });

        it("transient + unreliable composes: tick-unreliable only, no full-sync", () => {
            class State extends Schema {
                @type("string") name: string;
                @transient @unreliable @type("number") frame: number;
            }

            const state = new State();
            const encoder = getEncoder(state);

            state.name = "s";
            state.frame = 42;

            // encodeAll should omit `frame`
            const fresh = createInstanceFromReflection(state);
            fresh.decode(encoder.encodeAll());
            assert.strictEqual((fresh as any).name, "s");
            assert.strictEqual((fresh as any).frame, undefined);

            // reliable encode should NOT have `frame` (it's unreliable)
            fresh.decode(encoder.encode());
            assert.strictEqual((fresh as any).frame, undefined);

            // unreliable encode SHOULD have `frame`
            fresh.decode(encoder.encodeUnreliable());
            assert.strictEqual((fresh as any).frame, 42);

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });
    });

    describe("interaction with @view filtering", () => {
        it("@unreliable + @view: emits via unreliable channel for visible views", () => {
            class Entity extends Schema {
                @type("string") id: string;
                @unreliable @type("number") x: number = 0;
            }
            class State extends Schema {
                @view() @type({ map: Entity }) entities = new MapSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const e1 = new Entity().assign({ id: "one", x: 10 });
            state.entities.set("one", e1);

            const clientView = new StateView();
            clientView.add(state.entities.get("one"));

            // Reliable view pass: emits Entity's @view-tagged / inherited-filter
            // fields EXCEPT @unreliable ones.
            const sharedIt = { offset: 0 };
            const sharedReliable = encoder.encode(sharedIt);
            const sharedOffset = sharedIt.offset;
            const reliableView = encoder.encodeView(clientView, sharedOffset, sharedIt);

            const decoder = getDecoder(createInstanceFromReflection(state));
            decoder.decode(reliableView);
            assert.strictEqual((decoder.state as any).entities.get("one").id, "one");
            assert.strictEqual((decoder.state as any).entities.get("one").x, undefined,
                "unreliable field must not appear on reliable view pass");

            // Unreliable view pass: emits the @unreliable field
            const unreliableIt = { offset: 0 };
            const unreliableShared = encoder.encodeUnreliable(unreliableIt);
            const unreliableSharedOffset = unreliableIt.offset;
            const unreliableView = encoder.encodeUnreliableView(clientView, unreliableSharedOffset, unreliableIt);
            decoder.decode(unreliableView);
            assert.strictEqual((decoder.state as any).entities.get("one").x, 10);

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });
    });

    describe("same-field @unreliable + @view composition", () => {
        it("emits only via encodeUnreliableView for visible client, skipped everywhere else", () => {
            class State extends Schema {
                @type("string") prop: string;
                @unreliable @view() @type("number") secret: number;
            }

            const state = new State();
            const encoder = getEncoder(state);

            state.prop = "public";
            state.secret = 123;

            // Visible client: view.add(state) to grant access.
            const clientVisible = new StateView();
            clientVisible.add(state);

            // Non-visible client: no view.add — state tree is NOT in visible set.
            const clientHidden = new StateView();

            // Shared reliable encode: only `prop` (reliable + unfiltered).
            const sharedIt = { offset: 0 };
            const sharedBytes = encoder.encode(sharedIt);
            const sharedOffset = sharedIt.offset;

            // Reliable view pass: secret is filtered but also @unreliable → NOT
            // emitted here (filtered+unreliable belongs to the unreliable view path).
            const visibleReliable = encoder.encodeView(clientVisible, sharedOffset, sharedIt);
            const decodedVisible = createInstanceFromReflection(state) as State;
            getDecoder(decodedVisible).decode(visibleReliable);
            assert.strictEqual((decodedVisible as any).prop, "public");
            assert.strictEqual((decodedVisible as any).secret, undefined,
                "@unreliable + @view must NOT emit on the reliable view pass");

            // Shared unreliable encode: secret is filtered (via @view) → skipped
            // in shared unreliable pass, only per-view pass emits it.
            const uSharedIt = { offset: 0 };
            const uShared = encoder.encodeUnreliable(uSharedIt);
            const uSharedOffset = uSharedIt.offset;
            // Even a fresh decoder on only shared-unreliable bytes should not see secret.
            const sharedOnly = createInstanceFromReflection(state) as State;
            // bootstrap to make refs available
            getDecoder(sharedOnly).decode(encoder.encodeAll());
            getDecoder(sharedOnly).decode(uShared);
            assert.strictEqual((sharedOnly as any).secret, undefined,
                "@unreliable + @view must NOT emit on the shared unreliable pass");

            // Unreliable view pass for visible client: secret IS emitted.
            const uView = encoder.encodeUnreliableView(clientVisible, uSharedOffset, uSharedIt);
            getDecoder(decodedVisible).decode(uView);
            assert.strictEqual((decodedVisible as any).secret, 123);

            // Unreliable view pass for hidden client: secret NOT emitted.
            const uSharedIt2 = { offset: 0 };
            encoder.encodeUnreliable(uSharedIt2);
            const uSharedOffset2 = uSharedIt2.offset;
            const uViewHidden = encoder.encodeUnreliableView(clientHidden, uSharedOffset2, uSharedIt2);
            const decodedHidden = createInstanceFromReflection(state) as State;
            getDecoder(decodedHidden).decode(encoder.encodeAll());
            getDecoder(decodedHidden).decode(uViewHidden);
            assert.strictEqual((decodedHidden as any).prop, "public");
            assert.strictEqual((decodedHidden as any).secret, undefined,
                "hidden client must never receive @view-tagged secret");

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });
    });

    describe("strict ref-type validation + packet loss safety", () => {
        // `@unreliable` is rejected at decoration time on ref-type fields
        // (Schema sub-classes, MapSchema, ArraySchema, SetSchema,
        // CollectionSchema). The structural ADD of a ref must arrive so
        // the decoder learns the refId; allowing it on the unreliable
        // channel would leave the decoder permanently desynced after a
        // dropped packet. Users mark each primitive sub-field instead.
        it("rejects @unreliable on a Schema ref-type field at decoration time", () => {
            class Position extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }
            assert.throws(() => {
                class _State extends Schema {
                    @unreliable @type(Position) position: Position;
                }
                void _State;
            }, /@unreliable cannot be applied to ref-type field/);
        });

        it("rejects @unreliable on an ArraySchema field at decoration time", () => {
            class Item extends Schema { @type("number") n: number; }
            assert.throws(() => {
                class _State extends Schema {
                    @unreliable @type([Item]) items: ArraySchema<Item>;
                }
                void _State;
            }, /@unreliable cannot be applied to ref-type field/);
        });

        it("rejects @unreliable on a MapSchema field at decoration time", () => {
            class Item extends Schema { @type("number") n: number; }
            assert.throws(() => {
                class _State extends Schema {
                    @unreliable @type({ map: Item }) items: MapSchema<Item>;
                }
                void _State;
            }, /@unreliable cannot be applied to ref-type field/);
        });

        // Verifies the reason the strict rule exists: with primitive-only
        // @unreliable, the structural ADDs always arrive on the reliable
        // channel, so dropping any unreliable packet only loses values —
        // the decoder remains in a consistent state.
        it("dropping unreliable packets only loses field values, never desyncs the structure", () => {
            class Position extends Schema {
                @unreliable @type("number") x: number;
                @unreliable @type("number") y: number;
            }
            class State extends Schema {
                @type(Position) position: Position;
            }

            const state = new State();
            const encoder = getEncoder(state);
            const decoded = createInstanceFromReflection(state) as State;
            const decoder = getDecoder(decoded);

            // Tick 1: structural ADD arrives reliable; x/y queued unreliable.
            state.position = new Position();
            state.position.x = 10;
            state.position.y = 20;

            decoder.decode(encoder.encode());
            assert.notStrictEqual((decoded as any).position, undefined,
                "Position refId established via reliable channel");
            assert.strictEqual((decoded as any).position.x, undefined,
                "x must NOT be on reliable channel (it's @unreliable)");

            // Drop tick 1's unreliable packet entirely.
            void encoder.encodeUnreliable();
            encoder.discardChanges();
            encoder.discardUnreliableChanges();

            // Tick 2: more x/y mutations.
            state.position.x = 30;
            state.position.y = 40;
            const reliableBytes2 = encoder.encode();
            if (reliableBytes2.length > 0) decoder.decode(reliableBytes2);
            decoder.decode(encoder.encodeUnreliable());
            encoder.discardChanges();
            encoder.discardUnreliableChanges();

            assert.strictEqual((decoded as any).position.x, 30,
                "decoder applies tick 2 values without ever seeing tick 1");
            assert.strictEqual((decoded as any).position.y, 40);
        });
    });

    describe("isFieldUnreliable classification", () => {
        it("Schema field: unreliable iff metadata says so", () => {
            class S extends Schema {
                @type("string") a: string;
                @unreliable @type("number") b: number;
            }
            const s = new S();
            const ct = (s as any).constructor[Symbol.metadata];
            assert.strictEqual(s[$changes] ? s[$changes].isFieldUnreliable(0) : false, false);
            assert.strictEqual(s[$changes] ? s[$changes].isFieldUnreliable(1) : false, true);
        });

        // The previous "collection inherits isUnreliable from parent field"
        // test exercised `@unreliable @type([Pt])`. The strict rule forbids
        // that pattern at decoration time — see the "strict ref-type
        // validation" describe block above. The inheritance code remains
        // for defense-in-depth but is no longer reachable from the public
        // decorator/builder API.

        // The encoder caches a per-class `unreliableBitmask` that covers
        // field indexes 0–31 only (matches the existing filterBitmask
        // limitation). Fields ≥32 must fall back to the slower
        // `Metadata.hasUnreliableAtIndex` linear scan; this test exercises
        // both code paths and verifies routing still works end-to-end.
        it("classification + routing works for @unreliable fields at index ≥32 (bitmask fallback)", () => {
            // Build 34 fields. Index 5 (low — bitmask) and index 33 (high —
            // fallback) carry @unreliable; everything else is reliable.
            const fields: Record<string, any> = {};
            for (let i = 0; i < 34; i++) {
                if (i === 5 || i === 33) {
                    fields[`f${i}`] = t.number().unreliable();
                } else {
                    fields[`f${i}`] = t.number();
                }
            }
            const State = schema(fields, "WideUnreliable");

            const state = new State() as any;
            const encoder = getEncoder(state);
            const ct: any = state[$changes];

            // Spot-check classification across both paths.
            assert.strictEqual(ct.isFieldUnreliable(0), false, "plain field 0");
            assert.strictEqual(ct.isFieldUnreliable(5), true, "bitmask path: index 5");
            assert.strictEqual(ct.isFieldUnreliable(31), false, "bitmask boundary (31): plain");
            assert.strictEqual(ct.isFieldUnreliable(32), false, "fallback boundary (32): plain");
            assert.strictEqual(ct.isFieldUnreliable(33), true, "fallback path: index 33");

            // End-to-end routing: mutate a low-index (bitmask) and a
            // high-index (fallback) unreliable field plus a reliable field;
            // assert each appears on the correct channel.
            const decoded = createInstanceFromReflection(state) as any;
            const decoder = getDecoder(decoded);

            state.f0 = 100;   // reliable
            state.f5 = 50;    // unreliable via bitmask
            state.f33 = 33;   // unreliable via fallback

            decoder.decode(encoder.encode());
            assert.strictEqual(decoded.f0, 100, "reliable field decoded");
            assert.strictEqual(decoded.f5, undefined, "unreliable (bitmask) NOT on reliable channel");
            assert.strictEqual(decoded.f33, undefined, "unreliable (fallback) NOT on reliable channel");

            decoder.decode(encoder.encodeUnreliable());
            assert.strictEqual(decoded.f5, 50, "unreliable (bitmask) decoded via unreliable channel");
            assert.strictEqual(decoded.f33, 33, "unreliable (fallback) decoded via unreliable channel");

            encoder.discardChanges();
            encoder.discardUnreliableChanges();
        });
    });

});
