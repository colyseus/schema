import * as assert from "assert";
import {
    schema,
    t,
    type,
    Schema,
    BitfieldValue,
    Encoder,
    Metadata,
} from "../src";
import { OPERATION } from "../src/encoding/spec";
import { Callbacks } from "../src/decoder/strategy/Callbacks";
import {
    createInstanceFromReflection,
    encodeAndAssertEquals,
    getDecoder,
} from "./Schema";

describe("Bitfield (t.bitfield)", () => {
    describe("layout", () => {
        it("8 booleans pack into 1 byte (uint8 backing)", () => {
            const Player = schema({
                flags: t.bitfield({
                    a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                    e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
                }),
            }, "Player");

            const player = new Player();
            player.flags.a = true;
            player.flags.c = true;
            player.flags.e = true;
            player.flags.g = true;

            const encoded = player.encode();
            // 1 byte op (0x80 = ADD | index 0) + 1 byte payload
            assert.strictEqual(encoded.length, 2);
            assert.strictEqual(encoded[0], OPERATION.ADD | 0);
            // bits 0,2,4,6 = 1010101 = 0x55
            assert.strictEqual(encoded[1], 0b01010101);
        });

        it("9 bits promote to 2-byte payload (uint16 backing)", () => {
            const S = schema({
                flags: t.bitfield({
                    a: t.bool(),
                    b: t.uint(8),
                }),
            }, "S");

            const s = new S();
            s.flags.a = true;
            s.flags.b = 0xff; // all 8 bits

            const encoded = s.encode();
            // 1 byte op + 2 byte payload
            assert.strictEqual(encoded.length, 3);
            assert.strictEqual(encoded[0], OPERATION.ADD | 0);
            // a=1 (bit 0), b=0xff (bits 1..8) → 0b1_11111111_1 → 0x1ff
            // little-endian: low byte first = 0xff, high byte = 0x01
            assert.strictEqual(encoded[1], 0xff);
            assert.strictEqual(encoded[2], 0x01);
        });

        it("17 bits promote to 4-byte payload (uint32 backing)", () => {
            const S = schema({
                flags: t.bitfield({
                    a: t.uint(17), // 17 bits
                }),
            }, "S");
            const s = new S();
            s.flags.a = 0x1ffff; // all 17 bits set

            const encoded = s.encode();
            assert.strictEqual(encoded.length, 5);
            assert.strictEqual(encoded[0], OPERATION.ADD | 0);
            // little-endian 32-bit
            assert.strictEqual(encoded[1], 0xff);
            assert.strictEqual(encoded[2], 0xff);
            assert.strictEqual(encoded[3], 0x01);
            assert.strictEqual(encoded[4], 0x00);
        });

        it("mixed bools + narrow uints pack in declaration order", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),    // bit 0
                    canJump: t.bool(),    // bit 1
                    health:  t.uint(7),   // bits 2..8
                    klass:   t.uint(4),   // bits 9..12
                    spare:   t.bool(),    // bit 13
                }),
            }, "Player");

            const p = new Player();
            p.flags.isAlive = true;
            p.flags.canJump = false;
            p.flags.health = 100;
            p.flags.klass = 5;
            p.flags.spare = true;

            // Total bits = 14 → uint16 → 2 bytes payload.
            // bit 0 = 1, bit 1 = 0, bits 2..8 = 100 = 0b1100100,
            // bits 9..12 = 5 = 0b0101, bit 13 = 1.
            // Packed: 1<<0 | 100<<2 | 5<<9 | 1<<13 = 1 + 400 + 2560 + 8192 = 11153 = 0x2B91
            const encoded = p.encode();
            assert.strictEqual(encoded.length, 3);
            assert.strictEqual(encoded[1], 0x91);
            assert.strictEqual(encoded[2], 0x2b);

            // Round-trip
            const decoded = createInstanceFromReflection(p);
            decoded.decode(encoded);
            assert.strictEqual(decoded.flags.isAlive, true);
            assert.strictEqual(decoded.flags.canJump, false);
            assert.strictEqual(decoded.flags.health, 100);
            assert.strictEqual(decoded.flags.klass, 5);
            assert.strictEqual(decoded.flags.spare, true);
        });

        it("counts as 1 toward the 64-field cap", () => {
            // 60 numbers + 1 bitfield with 8 bool sub-fields = 61 wire slots,
            // but 68 sub-fields total. Should NOT throw.
            const fields: any = {};
            for (let i = 0; i < 60; i++) fields["n" + i] = t.uint8();
            fields.flags = t.bitfield({
                a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
            });
            assert.doesNotThrow(() => schema(fields, "ManyFields"));
        });
    });

    describe("decoration-time errors", () => {
        it("t.uint(0) throws", () => {
            assert.throws(() => t.uint(0), /1\.\.32/);
        });

        it("t.uint(33) throws", () => {
            assert.throws(() => t.uint(33), /1\.\.32/);
        });

        it("t.uint(1.5) throws", () => {
            assert.throws(() => t.uint(1.5), /integer/);
        });

        it("total bits > 32 throws", () => {
            assert.throws(
                () => t.bitfield({ a: t.uint(20), b: t.uint(20) }),
                /total bits exceed 32/,
            );
        });

        it("t.uint(n) at top-level throws at decoration time", () => {
            assert.throws(() => {
                schema({ score: t.uint(7) as any }, "Bad");
            }, /t\.uint\(7\) at the top level/);
        });

        it("non-bool/non-uint sub-field throws", () => {
            assert.throws(
                () => t.bitfield({ s: t.string() } as any),
                /must be t\.bool\(\) or t\.uint/,
            );
        });

        it("empty layout throws", () => {
            assert.throws(() => t.bitfield({}), /at least one sub-field/);
        });
    });

    describe("default values", () => {
        it("auto-defaults to a fresh BitfieldValue with _packed = 0", () => {
            const S = schema({
                flags: t.bitfield({
                    a: t.bool(),
                    b: t.uint(7),
                }),
            }, "S");
            const s = new S();
            assert.ok(s.flags instanceof BitfieldValue);
            assert.strictEqual(s.flags.a, false);
            assert.strictEqual(s.flags.b, 0);
        });

        it("partial .default() seeds matching sub-fields", () => {
            const S = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    canJump: t.bool(),
                    health: t.uint(7),
                }).default({ isAlive: true, health: 100 } as any),
            }, "S");
            const s = new S();
            assert.strictEqual(s.flags.isAlive, true);
            assert.strictEqual(s.flags.canJump, false); // not in default → 0
            assert.strictEqual(s.flags.health, 100);
        });

        it("default is per-instance (no aliasing across instances)", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool() })
                    .default({ a: true } as any),
            }, "S");
            const s1 = new S();
            const s2 = new S();
            s1.flags.a = false;
            assert.strictEqual(s2.flags.a, true); // s2 unaffected
        });
    });

    describe("change tracking", () => {
        it("multiple sub-writes in same tick coalesce into single dirty mark", () => {
            const S = schema({
                flags: t.bitfield({
                    a: t.bool(), b: t.bool(), c: t.bool(),
                }),
            }, "S");
            const s = new S();
            // Start with a fresh encode to clear initial-state dirties.
            s.encode();

            s.flags.a = true;
            s.flags.b = true;
            s.flags.c = true;

            const encoded = s.encode();
            // Should still be 1 op + 1 payload byte (one wire slot).
            assert.strictEqual(encoded.length, 2);
            assert.strictEqual(encoded[1], 0b00000111);
        });

        it("setting same sub-value is a no-op", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool() }),
            }, "S");
            const s = new S();
            s.flags.a = true;
            s.encode(); // clear

            s.flags.a = true; // same value
            const encoded = s.encode();
            assert.strictEqual(encoded.length, 0);
        });
    });

    describe("BitfieldValue API", () => {
        it("toJSON returns a plain object", () => {
            const S = schema({
                flags: t.bitfield({
                    a: t.bool(),
                    b: t.uint(4),
                }),
            }, "S");
            const s = new S();
            s.flags.a = true;
            s.flags.b = 7;
            assert.deepStrictEqual(s.flags.toJSON(), { a: true, b: 7 });
        });

        it("clone() copies _packed without parent link", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool(), b: t.uint(4) }),
            }, "S");
            const s = new S();
            s.flags.a = true;
            s.flags.b = 9;

            const c = s.flags.clone();
            assert.ok(c instanceof BitfieldValue);
            assert.strictEqual(c.a, true);
            assert.strictEqual(c.b, 9);
            assert.strictEqual(c._parent, undefined);
        });

        it("instanceof BitfieldValue is true", () => {
            const S = schema({ flags: t.bitfield({ a: t.bool() }) }, "S");
            const s = new S();
            assert.ok(s.flags instanceof BitfieldValue);
        });
    });

    describe("encode/decode round-trip", () => {
        it("toggling sub-fields propagates correctly", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    canJump: t.bool(),
                    health:  t.uint(7),
                }),
                name: t.string(),
            }, "Player");

            const server = new Player();
            server.flags.isAlive = true;
            server.flags.canJump = true;
            server.flags.health = 75;
            server.name = "alice";

            const client = createInstanceFromReflection(server);
            client.decode(server.encode());

            assert.strictEqual(client.flags.isAlive, true);
            assert.strictEqual(client.flags.canJump, true);
            assert.strictEqual(client.flags.health, 75);
            assert.strictEqual(client.name, "alice");

            // Subsequent patch
            server.flags.health = 50;
            client.decode(server.encode());
            assert.strictEqual(client.flags.health, 50);
            assert.strictEqual(client.flags.isAlive, true); // unchanged

            // Toggle a single bit
            server.flags.isAlive = false;
            client.decode(server.encode());
            assert.strictEqual(client.flags.isAlive, false);
            assert.strictEqual(client.flags.canJump, true);
            assert.strictEqual(client.flags.health, 50);
        });

        it("works with subsequent ticks (REPLACE op)", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool(), b: t.bool() }),
            }, "S");

            const server = new S();
            server.flags.a = true;
            const client = createInstanceFromReflection(server);
            client.decode(server.encode());

            server.flags.b = true;
            client.decode(server.encode());

            assert.strictEqual(client.flags.a, true);
            assert.strictEqual(client.flags.b, true);
        });

        it("round-trips alongside other field types", () => {
            const Entity = schema({
                id: t.uint32(),
                flags: t.bitfield({
                    isAlive: t.bool(),
                    health: t.uint(7),
                }),
                name: t.string(),
            }, "Entity");

            const e = new Entity();
            e.id = 42;
            e.flags.isAlive = true;
            e.flags.health = 100;
            e.name = "test";

            const decoded = createInstanceFromReflection(e);
            decoded.decode(e.encode());

            assert.strictEqual(decoded.id, 42);
            assert.strictEqual(decoded.flags.isAlive, true);
            assert.strictEqual(decoded.flags.health, 100);
            assert.strictEqual(decoded.name, "test");
        });
    });

    describe("inheritance", () => {
        it("subclass with its own bitfield doesn't shift parent layout", () => {
            const Base = schema({
                base: t.bitfield({ a: t.bool(), b: t.bool() }),
            }, "Base");
            const Child = Base.extend({
                child: t.bitfield({ x: t.uint(4) }),
            }, "Child");

            const c = new Child();
            c.base.a = true;
            c.child.x = 9;

            const decoded = createInstanceFromReflection(c);
            decoded.decode(c.encode());

            assert.strictEqual((decoded as any).base.a, true);
            assert.strictEqual((decoded as any).base.b, false);
            assert.strictEqual((decoded as any).child.x, 9);
        });
    });

    describe("Reflection round-trip", () => {
        it("reflection-decoded schema preserves bitfield layout", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    health:  t.uint(7),
                    klass:   t.uint(4),
                }),
                name: t.string(),
            }, "Player");

            const server = new Player();
            server.flags.isAlive = true;
            server.flags.health = 88;
            server.flags.klass = 12;
            server.name = "bob";

            // Reflection-decoded client
            const client = createInstanceFromReflection(server);
            client.decode(server.encode());

            assert.strictEqual(client.flags.isAlive, true);
            assert.strictEqual(client.flags.health, 88);
            assert.strictEqual(client.flags.klass, 12);
            assert.strictEqual(client.name, "bob");

            // Layout reconstructed: setting via the reconstructed accessors
            // updates the right bits. (We can't test encode from a reflection-
            // decoded instance directly because the server side is canonical,
            // but we can verify _packed via toJSON.)
            assert.deepStrictEqual(client.flags.toJSON(), {
                isAlive: true,
                health: 88,
                klass: 12,
            });
        });
    });

    describe("decorator API", () => {
        it("@type(t.bitfield(...)) works on a Schema subclass", () => {
            class Player extends Schema {
                @type(t.bitfield({
                    isAlive: t.bool(),
                    canJump: t.bool(),
                    health: t.uint(7),
                }))
                flags: any;

                @type("string") name: string;
            }

            const p = new Player();
            p.flags.isAlive = true;
            p.flags.health = 88;
            p.name = "alice";

            const encoded = p.encode();
            const decoded = createInstanceFromReflection(p);
            decoded.decode(encoded);

            assert.strictEqual(decoded.flags.isAlive, true);
            assert.strictEqual(decoded.flags.canJump, false);
            assert.strictEqual(decoded.flags.health, 88);
            assert.strictEqual(decoded.name, "alice");
        });

        it("@type(t.bitfield(...)) emits the same wire bytes as schema()/builder", () => {
            class DecPlayer extends Schema {
                @type(t.bitfield({
                    a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                    e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
                }))
                flags: any;
            }

            const SchPlayer = schema({
                flags: t.bitfield({
                    a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                    e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
                }),
            }, "SchPlayer");

            const decP = new DecPlayer();
            decP.flags.a = true; decP.flags.c = true; decP.flags.e = true; decP.flags.g = true;

            const schP = new SchPlayer();
            schP.flags.a = true; schP.flags.c = true; schP.flags.e = true; schP.flags.g = true;

            assert.deepStrictEqual(Array.from(decP.encode()), Array.from(schP.encode()));
        });

        it("@type({ bitfield: layoutObj }) works with a manually-built layout (advanced)", () => {
            // Verifies the lower-level decorator path still works for users
            // who construct the layout by hand. Equivalent to the sugar
            // tested above; kept for back-compat with custom-type registries.
            const builder = t.bitfield({ a: t.bool(), b: t.uint(7) });
            const layout = (builder as any)._type.bitfield;

            class Manual extends Schema {
                @type({ bitfield: layout } as any) flags: any;
            }

            const m = new Manual();
            m.flags.a = true;
            m.flags.b = 100;

            const decoded = createInstanceFromReflection(m);
            decoded.decode(m.encode());
            assert.strictEqual(decoded.flags.a, true);
            assert.strictEqual(decoded.flags.b, 100);
        });

        it("decorator path rejects t.uint(n) at top-level", () => {
            assert.throws(() => {
                class Bad extends Schema {
                    @type(t.uint(7)) score: number;
                }
            }, /t\.uint\(7\) at the top level/);
        });

        it("@type(t.bitfield(...)) round-trips REPLACE on subsequent ticks", () => {
            class Entity extends Schema {
                @type(t.bitfield({
                    on: t.bool(),
                    level: t.uint(4),
                }))
                flags: any;
            }

            const server = new Entity();
            server.flags.on = true;
            const client = createInstanceFromReflection(server);
            client.decode(server.encode());

            server.flags.level = 9;
            client.decode(server.encode());
            assert.strictEqual(client.flags.on, true);
            assert.strictEqual(client.flags.level, 9);
        });
    });

    describe("decoder callbacks", () => {
        it("listen() fires on initial decode with (current, undefined)", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    health: t.uint(7),
                }),
            }, "Player");

            const server = new Player();
            server.flags.isAlive = true;
            server.flags.health = 80;

            const client = createInstanceFromReflection(server);
            const callbacks = Callbacks.get(getDecoder(client));

            let cur: BitfieldValue | undefined;
            let prev: BitfieldValue | undefined;
            let calls = 0;
            callbacks.listen("flags" as any, (c: any, p: any) => {
                cur = c;
                prev = p;
                calls++;
            });

            client.decode(server.encode());
            assert.strictEqual(calls, 1);
            assert.ok(cur instanceof BitfieldValue);
            assert.strictEqual((cur as any).isAlive, true);
            assert.strictEqual((cur as any).health, 80);
            assert.strictEqual(prev, undefined);
        });

        it("listen() fires on subsequent change with distinct previous/current", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    canJump: t.bool(),
                    health: t.uint(7),
                }),
            }, "Player");

            const server = new Player();
            server.flags.isAlive = true;
            server.flags.health = 100;

            const client = createInstanceFromReflection(server);
            const callbacks = Callbacks.get(getDecoder(client));

            let cur: any;
            let prev: any;
            let calls = 0;
            callbacks.listen("flags" as any, (c: any, p: any) => {
                cur = c;
                prev = p;
                calls++;
            });

            client.decode(server.encode());
            assert.strictEqual(calls, 1);

            // Mutate sub-fields on the server
            server.flags.health = 50;
            server.flags.canJump = true;
            client.decode(server.encode());

            assert.strictEqual(calls, 2);
            assert.ok(cur instanceof BitfieldValue);
            assert.ok(prev instanceof BitfieldValue);
            assert.notStrictEqual(cur, prev,
                "previous and current must be distinct BitfieldValue snapshots");

            // current reflects the NEW packed state
            assert.strictEqual(cur.isAlive, true);
            assert.strictEqual(cur.canJump, true);
            assert.strictEqual(cur.health, 50);

            // previous reflects the OLD packed state
            assert.strictEqual(prev.isAlive, true);
            assert.strictEqual(prev.canJump, false);
            assert.strictEqual(prev.health, 100);
        });

        it("listen() does NOT fire when sub-fields don't change", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool() }),
                other: t.uint8(),
            }, "S");

            const server = new S();
            server.flags.a = true;
            server.other = 1;

            const client = createInstanceFromReflection(server);
            const callbacks = Callbacks.get(getDecoder(client));

            let calls = 0;
            callbacks.listen("flags" as any, () => calls++);

            client.decode(server.encode());
            assert.strictEqual(calls, 1); // initial

            // Change only `other`, not flags
            server.other = 2;
            client.decode(server.encode());
            assert.strictEqual(calls, 1, "flags listener must not fire on unrelated changes");
        });

        it("listen() returns an unbind function", () => {
            const S = schema({
                flags: t.bitfield({ a: t.bool() }),
            }, "S");

            const server = new S();
            const client = createInstanceFromReflection(server);
            const callbacks = Callbacks.get(getDecoder(client));

            let calls = 0;
            const unbind = callbacks.listen("flags" as any, () => calls++);

            client.decode(server.encode());
            const callsAfterFirst = calls;

            unbind();

            server.flags.a = true;
            client.decode(server.encode());
            assert.strictEqual(calls, callsAfterFirst, "unbound listener must not fire");
        });

        it("nested listen on a Schema-ref's bitfield works", () => {
            const Player = schema({
                flags: t.bitfield({
                    isAlive: t.bool(),
                    health: t.uint(7),
                }),
                name: t.string(),
            }, "Player");

            const Room = schema({
                player: Player,
            }, "Room");

            const server = new Room();
            server.player.name = "alice";
            server.player.flags.isAlive = true;
            server.player.flags.health = 100;

            const client = createInstanceFromReflection(server);
            const callbacks = Callbacks.get(getDecoder(client));

            let cur: any;
            let prev: any;

            callbacks.listen("player" as any, (player: any) => {
                if (player) {
                    callbacks.listen(player, "flags", (c: any, p: any) => {
                        cur = c;
                        prev = p;
                    });
                }
            });

            client.decode(server.encode());
            assert.strictEqual(cur?.isAlive, true);
            assert.strictEqual(cur?.health, 100);

            server.player.flags.health = 60;
            client.decode(server.encode());

            assert.strictEqual(cur?.health, 60);
            assert.strictEqual(prev?.health, 100);
        });
    });

    describe("bandwidth comparison", () => {
        it("8 booleans in a bitfield save 7 bytes vs separate fields", () => {
            // With 8 separate boolean fields (current API):
            const Wide = schema({
                a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
            }, "Wide");
            const wide = new Wide();
            wide.a = true; wide.b = true; wide.c = true; wide.d = true;
            wide.e = true; wide.f = true; wide.g = true; wide.h = true;
            const wideBytes = wide.encode().length;

            // With one bitfield holding the same 8 booleans:
            const Packed = schema({
                flags: t.bitfield({
                    a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
                    e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
                }),
            }, "Packed");
            const packed = new Packed();
            packed.flags.a = true; packed.flags.b = true;
            packed.flags.c = true; packed.flags.d = true;
            packed.flags.e = true; packed.flags.f = true;
            packed.flags.g = true; packed.flags.h = true;
            const packedBytes = packed.encode().length;

            // Wide: 8 fields × 2 bytes (op + value) = 16 bytes.
            // Packed: 1 field × 2 bytes (op + value) = 2 bytes.
            assert.strictEqual(wideBytes, 16);
            assert.strictEqual(packedBytes, 2);
            assert.strictEqual(wideBytes - packedBytes, 14);
        });
    });
});
