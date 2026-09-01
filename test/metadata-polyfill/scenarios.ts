//
// Runs under `preload.mjs`, which installs a core-js-style
// `Function.prototype[Symbol.metadata] = null`. Each check maps to a distinct
// way that inherited `null` broke things before 5.0.26.
//
// Driven as a child process by `test/MetadataPolyfill.test.ts`, once per
// `useDefineForClassFields` setting: the polyfill is non-configurable so it
// can't be torn down in-process, and the metadata slot the fix installs must
// not depend on how class fields are emitted. Schemas are declared with the
// `schema()` builder rather than `@type` for the same reason — decorated class
// fields carry their own emit-mode baggage, unrelated to what's under test.
//
import * as assert from "assert";

import { Schema, ArraySchema, MapSchema, SetSchema, CollectionSchema, StreamSchema, Reflection, schema, t } from "../../src";
import { Encoder } from "../../src/encoder/Encoder";
import { registeredTypes } from "../../src/types/registry";

// Inlined rather than imported from `../Schema`: that helper module declares
// decorated classes, whose emit differs between the two configs this file runs
// under. Nothing here may depend on how class fields are emitted.
function encodeAllAndAssertRefCounts<T extends Schema>(state: T, encoder: Encoder<T>) {
    const decoder = Reflection.decode<T>(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());
    assert.deepStrictEqual(decoder.state.toJSON(), state.toJSON());

    for (const refId in encoder.root.refCount) {
        assert.strictEqual(
            encoder.root.refCount[refId],
            decoder.root.refCount[refId] ?? 0,
            `refCount mismatch for refId ${refId}`,
        );
    }
    for (const refId of decoder.root.refs.keys()) {
        assert.ok(encoder.root.refCount[refId] > 0, `decoder holds orphan refId ${refId}`);
    }
}

assert.strictEqual(
    (Function.prototype as any)[Symbol.metadata],
    null,
    "preload.mjs did not take effect — these scenarios prove nothing without it",
);

const checks: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => checks.push([name, fn]);

check("collections construct without reading Function.prototype metadata", () => {
    // Every one of these threw "Cannot read properties of null (reading
    // '~__numFields')" out of buildFieldArrays.
    new ArraySchema();
    new MapSchema();
    new SetSchema();
    new CollectionSchema();
    new StreamSchema();
});

check("metadata roots own their slot rather than inheriting null", () => {
    // Driven off the registry rather than a hand-listed set, so a collection
    // type added later is covered without editing this file.
    const roots = [Schema, ...Object.values(registeredTypes).map((d) => d.constructor)];
    assert.ok(roots.length > 5, "registry looks empty — the roots are not being checked");

    for (const ctor of roots) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(ctor, Symbol.metadata),
            `${ctor.name} must own Symbol.metadata`,
        );
        assert.strictEqual((ctor as any)[Symbol.metadata], undefined);
    }

    class Plain extends Schema { }
    assert.strictEqual((Plain as any)[Symbol.metadata], undefined, "subclass must inherit Schema's slot, not Function.prototype's");
});

check("Schema.is() rejects plain functions", () => {
    // `typeof null === "object"` let every function through.
    assert.strictEqual(Schema.is(function () { } as any), false);
    assert.strictEqual(Schema.is(class { } as any), false);
    assert.strictEqual(Schema.is("number" as any), false);

    assert.strictEqual(Schema.is(schema({ x: t.number() })), true);
});

check("schema() keeps methods as methods", () => {
    // Misclassified as a Schema field via Schema.is(), then dereferenced:
    // "Cannot read properties of undefined (reading 'initialize')".
    const Vec = schema({
        x: t.number(),
        double() { return this.x * 2; },
    });
    const vec = new Vec();
    vec.x = 7;
    assert.strictEqual(vec.double(), 14);
});

check("a fieldless Schema can be registered", () => {
    // `klass[Symbol.metadata] ??= {}` wrote through the prototype chain to the
    // non-writable Function.prototype slot: "Cannot assign to read only property".
    class EmptyState extends Schema { }
    new Encoder(new EmptyState());
});

check("Reflection handshake round-trips", () => {
    // The reported symptom: every room join failed inside Reflection.decode().
    const Player = schema({ x: t.number() }, "Player");
    const State = schema({ players: t.array(Player) }, "State");

    const state = new State();
    state.players.push(new Player().assign({ x: 1 }));
    const encoder = new Encoder(state);

    Reflection.decode(Reflection.encode(encoder));
    encodeAllAndAssertRefCounts(state, encoder);
});

check("collection children are dereferenced on the decoder", () => {
    // ReferenceTracker sent collections down the Schema branch, so their
    // children were never released — silent refcount drift, no exception.
    const Item = schema({ id: t.number() }, "Item");
    const Container = schema({ items: t.array(Item) }, "Container");
    const State = schema({ container: t.ref(Container).default(new Container()) }, "State");

    const state = new State();
    const encoder = new Encoder(state);
    state.container.items.push(new Item().assign({ id: 1 }));
    state.container.items.push(new Item().assign({ id: 2 }));
    encodeAllAndAssertRefCounts(state, encoder);

    state.container.items = new ArraySchema();
    encodeAllAndAssertRefCounts(state, encoder);
});

let failed = 0;
for (const [name, fn] of checks) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e: any) {
        failed++;
        console.error(`FAIL ${name}\n${e?.stack ?? e}`);
    }
}
process.exit(failed === 0 ? 0 : 1);
