import * as assert from "assert";

import { Schema, type, patchOnly, MapSchema } from "../src";
import { deprecated } from "../src/annotations";
import { Decoder } from "../src/decoder/Decoder";
import { DataChange } from "../src/decoder/DecodeOperation";
import { $numFields } from "../src/types/symbols";

import "./Schema";
import { assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder } from "./Schema";

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
            const decoder = new Decoder(target);

            assert.doesNotThrow(() => decoder.decode(getEncoder(state).encode()));

            assert.strictEqual("AAA", target.a);
            assert.strictEqual("BBB", target.b);
            assert.throws(() => target.mid, /deprecated/);
        });

        it("should consume a deprecated field on full sync too", () => {
            const state = new LivePeer();
            const target = new DeprecatedPeer();
            const decoder = new Decoder(target);

            assert.doesNotThrow(() => decoder.decode(getEncoder(state).encodeAll()));

            assert.strictEqual("AAA", target.a);
            assert.strictEqual("BBB", target.b);
        });

        it("should not emit a change for a deprecated field", () => {
            const state = new LivePeer();
            const target = new DeprecatedPeer();
            const decoder = new Decoder(target);

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
            new Decoder(target).decode(getEncoder(state).encode());

            assert.strictEqual("AAA", target.a);
        });
    });

});
