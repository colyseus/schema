// Declared map key types on the builder surface: `t.map(X, { key: "number" })`
// infers `MapSchema<X, number>`; a bare `t.map(X)` stays `MapSchema<X>` (string keys).
import { MapSchema, Schema, schema, t, type SchemaType, type StateCallbackStrategy } from "../../build/index.js";

const Item = schema({ name: t.string() }, "Item");
type Item = SchemaType<typeof Item>;

const State = schema({
    byId: t.map(Item, { key: "number" }),
    scores: t.map("number", { key: "int32" }),
    byName: t.map(Item),
    named: t.map(Item, { key: "string" }),
}, "State");
type State = SchemaType<typeof State>;

declare const state: State;

const byId: MapSchema<Item, number> = state.byId;
const scores: MapSchema<number, number> = state.scores;
const byName: MapSchema<Item> = state.byName;
const named: MapSchema<Item, string> = state.named;
void byId; void scores; void byName; void named;

state.byId.set(1, new Item());
state.scores.set(2, 3);
state.byName.set("k", new Item());
// @ts-expect-error a number-keyed map rejects string keys at the type level
state.byId.set("1", new Item());
// @ts-expect-error a string-keyed map rejects number keys at the type level
state.byName.set(1, new Item());

const idKeys: number[] = Array.from(state.byId.keys());
const nameKeys: string[] = Array.from(state.byName.keys());
void idKeys; void nameKeys;

// JSON keys are strings whatever the key type
const json: { byId: Record<string, { name: string }>, scores: Record<string, number> } = state.toJSON();
void json;

// a number-keyed MapSchema is a Map<number, V>
const asMap: Map<number, Item> = state.byId;
void asMap;

// callbacks receive the declared key type
declare const callbacks: StateCallbackStrategy<State>;
callbacks.onAdd("byId", (value: Item, key: number) => { void value; void key; });
callbacks.onRemove("scores", (value: number, key: number) => { void value; void key; });
callbacks.onAdd("byName", (value: Item, key: string) => { void value; void key; });

// init props accept the instance or a plain record
const s2: State = new State({ byId: new MapSchema<Item, number>(), byName: { a: new Item() } });
void s2;

class Plain extends Schema {}
void Plain;
