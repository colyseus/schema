// `ArraySchemaOptions { legacyCompat: true }` (declaration merging) types
// index and `length` writes as allowed, for a project that calls
// `enableLegacyCompat()`. Program-wide, hence its own tsconfig.
import { ArraySchema, Schema, schema, t, enableLegacyCompat, type SchemaType } from "../../build/index.js";

declare module "../../build/index.js" {
    interface ArraySchemaOptions { legacyCompat: true }
}

enableLegacyCompat();

const numbers = new ArraySchema<number>(1, 2, 3);
numbers[0] = 10;
numbers[1]++;
numbers.length = 0;

const plain: number[] = numbers;
void plain;

const joined: ArraySchema<number> = numbers.concat([4, 5]);
const replaced: ArraySchema<number> = numbers.with(0, 1);
void joined; void replaced;

// @ts-expect-error — the element type still applies
numbers[0] = "ten";

const Item = schema({ name: t.string() }, "Item");
const State = schema({ items: t.array(Item), tags: t.array("string") }, "State");
type State = SchemaType<typeof State>;

declare const state: State;
state.items[0] = new Item();
state.tags[0] = "a";
state.tags.length = 0;
void Schema;
