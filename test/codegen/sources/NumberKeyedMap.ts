import { Schema, type, MapSchema, schema, t } from "../../../src";

export class Item extends Schema {
    @type("string") name: string;
}

// `byName` is the string-keyed control and comes first so its emitted lines
// (and whatever attribute line precedes them) are position-independent from
// the number-keyed fields that follow.
export class KeyedDecorator extends Schema {
    @type({ map: Item }) byName = new MapSchema<Item>();
    @type({ map: Item, key: "number" }) byId = new MapSchema<Item, number>();
    @type({ map: "number", key: "int32" }) scores = new MapSchema<number, number>();
}

export const KeyedBuilder = schema({
    byName: t.map(Item),
    byId: t.map(Item, { key: "number" }),
    scores: t.map("number", { key: "int32" }),
}, "KeyedBuilder");
