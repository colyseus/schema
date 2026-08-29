import * as assert from "assert";

import { Schema, type, patchOnly, MapSchema, schema, t } from "../src";
import { deprecated } from "../src/annotations";
import { Decoder } from "../src/decoder/Decoder";
import { DataChange } from "../src/decoder/DecodeOperation";
import { $numFields, $fullSyncSkipIndexes } from "../src/types/symbols";

import "./Schema";
import { assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder, createDecoder } from "./Schema";

/** Field names by wire index, straight off a class's metadata. */
function fieldNames(klass: any): string[] {
    const metadata = klass[Symbol.metadata];
    const names: string[] = [];
    for (let i = 0; i <= metadata[$numFields]; i++) { names[i] = metadata[i]?.name; }
    return names;
}

describe("@deprecated()", () => {

    describe("full sync (encodeAll)", () => {
        class Child extends Schema {
            @type("number") x: number;
            @deprecated() @type("string") oldChild: string;
            @type("number") y: number;
        }

        class DeprecatedState extends Schema {
            @type("string") a = "one";
            @deprecated() @type("string") old: string;
            @type("string") b = "two";
            @type({ map: Child }) children = new MapSchema<Child>();
        }

        it("should not read through the throwing getter", () => {
            const state = new DeprecatedState();
            state.children.set("p1", new Child().assign({ x: 1, y: 2 }));

            assert.doesNotThrow(() => getEncoder(state).encodeAll());
        });

        it("should full-sync every non-deprecated field", () => {
            const state = new DeprecatedState();
            state.children.set("p1", new Child().assign({ x: 1, y: 2 }));

            assertDeepStrictEqualEncodeAll(state);

            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());

            assert.strictEqual("one", client.a);
            assert.strictEqual("two", client.b);
            assert.strictEqual(1, client.children.get("p1").x);
            assert.strictEqual(2, client.children.get("p1").y);
        });

        it("should keep skipping @patchOnly fields alongside deprecated ones", () => {
            class Mixed extends Schema {
                @type("string") kept = "kept";
                @deprecated() @type("string") old: string;
                @patchOnly @type("string") tick = "tick";
            }

            const state = new Mixed();
            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());

            assert.strictEqual("kept", client.kept);
            assert.strictEqual(undefined, client.tick, "@patchOnly must stay out of the snapshot");

            // ...and still arrive on a tick patch.
            client.decode(state.encode());
            assert.strictEqual("tick", client.tick);
        });

        it("should not leak a parent's deprecated indexes into a subclass", () => {
            class Base extends Schema {
                @type("string") base = "B";
                @deprecated() @type("string") oldBase: string;
            }
            class Derived extends Base {
                @type("string") extra = "E";
                @deprecated() @type("string") oldDerived: string;
                @type("string") last = "L";
            }
            class Holder extends Schema {
                // Derived's metadata inherits Base's through the prototype
                // chain — its skip list must be its own copy, not the parent's.
                @type(Base) base = new Base();
                @type(Derived) derived = new Derived();
            }

            const state = new Holder();
            assert.doesNotThrow(() => getEncoder(state).encodeAll());

            const client = createInstanceFromReflection(state);
            client.decode(state.encodeAll());

            assert.strictEqual("B", client.base.base);
            assert.strictEqual("E", client.derived.extra);
            assert.strictEqual("L", client.derived.last);
        });
    });

    describe("reflection", () => {
        class ReflectedState extends Schema {
            @type("string") a = "AAA";
            @deprecated() @type("string") mid: string;
            @type("string") b = "BBB";
        }

        class ControlState extends Schema {
            @type("string") a = "AAA";
            @type("string") mid = "MID";
            @type("string") b = "BBB";
        }

        it("should keep the deprecated slot so later fields keep their index", () => {
            const state = new ReflectedState();
            const client = createInstanceFromReflection(state);

            assert.deepStrictEqual(["a", "mid", "b"], fieldNames(client.constructor));
        });

        it("should not shift later fields on decode", () => {
            const state = new ReflectedState();
            const client = createInstanceFromReflection(state);

            client.decode(state.encode());

            assert.strictEqual("AAA", client.a);
            assert.strictEqual("BBB", client.b);
        });

        it("should preserve field positions across inheritance", () => {
            class RBase extends Schema {
                @type("string") one = "1";
                @deprecated() @type("string") oldBase: string;
                @type("string") two = "2";
            }
            class RDerived extends RBase {
                @type("string") three = "3";
                @deprecated() @type("string") oldDerived: string;
                @type("string") four = "4";
            }

            const state = new RDerived();
            const client = createInstanceFromReflection(state);

            assert.deepStrictEqual(
                ["one", "oldBase", "two", "three", "oldDerived", "four"],
                fieldNames(client.constructor),
            );

            client.decode(state.encode());

            assert.strictEqual("1", client.one);
            assert.strictEqual("2", client.two);
            assert.strictEqual("3", client.three);
            assert.strictEqual("4", client.four);
        });

        it("control: a schema without deprecated fields still round-trips unchanged", () => {
            const state = new ControlState();
            const client = createInstanceFromReflection(state);

            assert.deepStrictEqual(fieldNames(ControlState), fieldNames(client.constructor));

            client.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), client.toJSON());
        });
    });

    describe("decode", () => {
        class LivePeer extends Schema {
            @type("string") a = "AAA";
            @type("string") mid = "MID";
            @type("string") b = "BBB";
        }

        class DeprecatedPeer extends Schema {
            @type("string") a: string;
            @deprecated() @type("string") mid: string;
            @type("string") b: string;
        }

        it("should consume a value sent for a deprecated field without throwing", () => {
            const state = new LivePeer();
            const target = new DeprecatedPeer();
            const decoder = createDecoder(target);

            assert.doesNotThrow(() => decoder.decode(getEncoder(state).encode()));

            assert.strictEqual("AAA", target.a);
            assert.strictEqual("BBB", target.b);
            assert.throws(() => target.mid, /deprecated/);
        });

        it("should consume a deprecated field on full sync too", () => {
            const state = new LivePeer();
            const target = new DeprecatedPeer();
            const decoder = createDecoder(target);

            assert.doesNotThrow(() => decoder.decode(getEncoder(state).encodeAll()));

            assert.strictEqual("AAA", target.a);
            assert.strictEqual("BBB", target.b);
        });

        it("should not emit a change for a deprecated field", () => {
            const state = new LivePeer();
            const target = new DeprecatedPeer();
            const decoder = createDecoder(target);

            let changes: DataChange[] = [];
            decoder.triggerChanges = (all) => { changes = changes.concat(all); };

            assert.doesNotThrow(() => decoder.decode(getEncoder(state).encode()));

            assert.deepStrictEqual(["a", "b"], changes.map((change) => change.field));
        });

        it("should keep decoding when the deprecated field arrives last", () => {
            class LiveTail extends Schema {
                @type("string") a = "AAA";
                @type("string") tail = "TAIL";
            }
            class DeprecatedTail extends Schema {
                @type("string") a: string;
                @deprecated() @type("string") tail: string;
            }

            const state = new LiveTail();
            const target = new DeprecatedTail();
            createDecoder(target).decode(getEncoder(state).encode());

            assert.strictEqual("AAA", target.a);
        });
    });

    // `.deprecated()` routes through the same deprecated() function, but
    // schema() applies it AFTER type() has already installed the accessor,
    // whereas the decorator short-circuits type(). Every observable must match.
    describe("schema() .deprecated() parity", () => {
        class DChild extends Schema {
            @type("number") x: number;
            @deprecated() @type("string") oldChild: string;
            @type("number") y: number;
        }
        class DState extends Schema {
            @type("string") a = "one";
            @deprecated() @type("string") old: string;
            @deprecated(false) @type("string") soft = "soft";
            @type("string") b = "two";
            @type({ map: DChild }) children = new MapSchema<DChild>();
        }
        class DBase extends Schema {
            @type("string") base = "B";
            @deprecated() @type("string") oldBase: string;
        }
        class DDerived extends DBase {
            @type("string") extra = "E";
            @deprecated() @type("string") oldDerived: string;
            @type("string") last = "L";
        }

        const BChild = schema({
            x: t.number(),
            oldChild: t.string().deprecated(),
            y: t.number(),
        }, "BChild");
        const BState = schema({
            a: t.string().default("one"),
            old: t.string().deprecated(),
            soft: t.string().default("soft").deprecated(false),
            b: t.string().default("two"),
            children: t.map(BChild),
        }, "BState");
        const BBase = schema({
            base: t.string().default("B"),
            oldBase: t.string().deprecated(),
        }, "BBase");
        const BDerived = BBase.extend({
            extra: t.string().default("E"),
            oldDerived: t.string().deprecated(),
            last: t.string().default("L"),
        }, "BDerived");

        /** Same field layout, sent by a peer that still populates the deprecated slots. */
        const LivePeer = schema({
            a: t.string().default("AAA"),
            old: t.string().default("OLD"),
            soft: t.string().default("SOFT"),
            b: t.string().default("BBB"),
        }, "LivePeerParity");

        const styles = [
            { name: "decorator", State: DState, Child: DChild, Derived: DDerived },
            { name: "builder", State: BState, Child: BChild, Derived: BDerived },
        ] as const;

        /** Everything a deprecated field changes, as plain data — diffed across styles. */
        function observe({ State, Child, Derived }: typeof styles[number]) {
            const metadata = State[Symbol.metadata] as any;
            const state = new State() as any;
            state.children.set("p1", new Child().assign({ x: 1, y: 2 }));

            const attempt = (fn: () => unknown) => { try { return { value: fn() }; } catch (e) { return { throws: (e as Error).message }; } };
            const fullSync = (instance: any) => {
                const client = createInstanceFromReflection(instance);
                client.decode(getEncoder(instance).encodeAll());
                return client.toJSON();
            };

            const target = new State() as any;
            const decoder = createDecoder(target);
            const changed: string[] = [];
            decoder.triggerChanges = (all: DataChange[]) => { all.forEach((c) => changed.push(c.field)); };
            decoder.decode(getEncoder(new LivePeer()).encode());

            return {
                fieldNames: fieldNames(State),
                enumerableIndexes: Object.keys(metadata).filter((k) => /^\d+$/.test(k)),
                fullSyncSkip: metadata[$fullSyncSkipIndexes],
                protoDescriptor: Object.keys(Object.getOwnPropertyDescriptor(State.prototype, "old")),
                getThrowing: attempt(() => state.old),
                getSoft: attempt(() => state.soft),
                setThrowing: attempt(() => { state.old = "z"; }),
                ownKeys: Object.keys(state),
                toJSON: state.toJSON(),
                fullSync: fullSync(state),
                reflectedFieldNames: fieldNames(createInstanceFromReflection(state).constructor),
                derivedFieldNames: fieldNames(Derived),
                derivedFullSyncSkip: (Derived[Symbol.metadata] as any)[$fullSyncSkipIndexes],
                derivedFullSync: fullSync(new Derived()),
                decodedFromLivePeer: { a: target.a, b: target.b, changed },
            };
        }

        it("behaves identically to @deprecated() in every observable", () => {
            const [decorator, builder] = styles.map(observe);

            // guard against vacuous equality: the deprecated field really is deprecated
            assert.match(decorator.getThrowing.throws, /deprecated/);
            assert.deepStrictEqual(decorator.fullSyncSkip, [1, 2]);

            assert.deepStrictEqual(builder, decorator);
        });
    });

});
