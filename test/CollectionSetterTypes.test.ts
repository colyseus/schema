import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema, CollectionSchema, SetSchema } from "../src";
import { EncodeSchemaError } from "../src/encoding/assert";
import { assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder } from "./Schema";

describe("Collection setter type assertions", () => {

    class Item extends Schema {
        @type("string") name: string;
    }

    class Prop extends Schema {
        @type("number") value: number;
    }

    describe("rejects untyped values at assign time", () => {
        it("plain objects assigned to @type([Item])", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            assert.throws(
                () => (state as any).items = [{ name: "Hello" }],
                (err: Error) => (
                    err instanceof EncodeSchemaError &&
                    err.message === "a 'Item' was expected, but 'Object' was provided in ArraySchema#0"
                )
            );
        });

        it("plain objects assigned to @type({ map: Prop })", () => {
            class State extends Schema {
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            assert.throws(
                () => (state as any).props = { one: { value: 1 } },
                (err: Error) => (
                    err instanceof EncodeSchemaError &&
                    err.message === "a 'Prop' was expected, but 'Object' was provided in MapSchema#one"
                )
            );
        });

        it("plain objects assigned via a native Map", () => {
            class State extends Schema {
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            assert.throws(
                () => (state as any).props = new Map([["one", { value: 1 }]]),
                (err: Error) => err.message === "a 'Prop' was expected, but 'Object' was provided in MapSchema#one"
            );
        });

        it("wrong Schema subclass is rejected too", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            assert.throws(
                () => (state as any).items = [new Prop()],
                (err: Error) => err.message === "a 'Item' was expected, but 'Prop' was provided in ArraySchema#0"
            );
        });

        it("assign via .assign() surfaces the same error", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            assert.throws(
                () => new State().assign({ items: [{ name: "Hello" }] as any }),
                (err: Error) => err.message === "a 'Item' was expected, but 'Object' was provided in ArraySchema#0"
            );
        });

        it("rejected assign leaves the field untouched", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            assert.throws(() => (state as any).items = [{ name: "Hello" }]);
            assert.strictEqual(undefined, state.items);
        });
    });

    describe("legitimate Schema values still work", () => {
        it("plain array of Schema instances", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            getEncoder(state);

            state.items = [new Item().assign({ name: "one" }), new Item().assign({ name: "two" })];

            assert.ok(state.items instanceof ArraySchema);
            assert.deepStrictEqual(["one", "two"], state.items.map((item) => item.name));

            assertDeepStrictEqualEncodeAll(state);

            const decoded = createInstanceFromReflection(state);
            decoded.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());
        });

        it("plain object of Schema instances", () => {
            class State extends Schema {
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            getEncoder(state);

            state.props = { one: new Prop().assign({ value: 1 }), two: new Prop().assign({ value: 2 }) } as any;

            assert.ok(state.props instanceof MapSchema);
            assert.strictEqual(1, state.props.get("one").value);
            assert.strictEqual(2, state.props.get("two").value);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("native Map of Schema instances", () => {
            class State extends Schema {
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            getEncoder(state);

            state.props = new Map([["one", new Prop().assign({ value: 1 })]]) as any;

            assert.ok(state.props instanceof MapSchema);
            assert.strictEqual(1, state.props.get("one").value);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("already-constructed ArraySchema / MapSchema instances", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            getEncoder(state);

            state.items = new ArraySchema<Item>(new Item().assign({ name: "one" }));
            state.props = new MapSchema<Prop>({ one: new Prop().assign({ value: 1 }) });

            assert.strictEqual("one", state.items[0].name);
            assert.strictEqual(1, state.props.get("one").value);

            assertDeepStrictEqualEncodeAll(state);

            // the assert is armed on those instances as well
            assert.throws(
                () => (state.items as any).push({ name: "nope" }),
                (err: Error) => err.message === "a 'Item' was expected, but 'Object' was provided in ArraySchema#0"
            );
            assert.throws(
                () => (state.props as any).set("two", { value: 2 }),
                (err: Error) => err.message === "a 'Prop' was expected, but 'Object' was provided in MapSchema#two"
            );
        });

        it("SetSchema / CollectionSchema assignment is unaffected", () => {
            class State extends Schema {
                @type({ set: Item }) set = new SetSchema<Item>();
                @type({ collection: Item }) collection = new CollectionSchema<Item>();
            }

            const state = new State();
            getEncoder(state);

            state.set = new SetSchema<Item>([new Item().assign({ name: "one" })]);
            state.collection = new CollectionSchema<Item>([new Item().assign({ name: "two" })]);

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("primitive collections still accept plain values", () => {
        it("@type(['number']) accepts a plain number array", () => {
            class State extends Schema {
                @type(["number"]) numbers: ArraySchema<number>;
            }

            const state = new State();
            getEncoder(state);

            state.numbers = [1, 2, 3, 4, 5];

            assert.ok(state.numbers instanceof ArraySchema);
            assert.deepStrictEqual([1, 2, 3, 4, 5], Array.from(state.numbers));

            assertDeepStrictEqualEncodeAll(state);
        });

        it("@type(['string']) accepts a plain string array", () => {
            class State extends Schema {
                @type(["string"]) strings: ArraySchema<string>;
            }

            const state = new State();
            getEncoder(state);

            state.strings = ["one", "two"];
            assert.deepStrictEqual(["one", "two"], Array.from(state.strings));

            assertDeepStrictEqualEncodeAll(state);
        });

        it("@type({ map: 'string' }) accepts a plain object", () => {
            class State extends Schema {
                @type({ map: "string" }) strings: MapSchema<string>;
            }

            const state = new State();
            getEncoder(state);

            state.strings = { one: "1", two: "2" } as any;

            assert.ok(state.strings instanceof MapSchema);
            assert.strictEqual("1", state.strings.get("one"));
            assert.strictEqual("2", state.strings.get("two"));

            assertDeepStrictEqualEncodeAll(state);
        });

        it("@type({ map: 'number' }) accepts a native Map", () => {
            class State extends Schema {
                @type({ map: "number" }) numbers: MapSchema<number>;
            }

            const state = new State();
            getEncoder(state);

            state.numbers = new Map([["one", 1], ["two", 2]]) as any;
            assert.strictEqual(1, state.numbers.get("one"));

            assertDeepStrictEqualEncodeAll(state);
        });

        it("empty plain array / object assignment", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
                @type({ map: Prop }) props: MapSchema<Prop>;
            }

            const state = new State();
            getEncoder(state);

            state.items = [];
            state.props = {} as any;

            assert.strictEqual(0, state.items.length);
            assert.strictEqual(0, state.props.size);

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("re-assignment", () => {
        it("replacing a populated collection keeps encoding consistent", () => {
            class State extends Schema {
                @type([Item]) items: ArraySchema<Item>;
            }

            const state = new State();
            const decoded = createInstanceFromReflection(state);

            state.items = [new Item().assign({ name: "one" })];
            decoded.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            state.items = [new Item().assign({ name: "two" }), new Item().assign({ name: "three" })];
            decoded.decode(state.encode());
            assert.deepStrictEqual(state.toJSON(), decoded.toJSON());

            assertDeepStrictEqualEncodeAll(state);
        });
    });
});
