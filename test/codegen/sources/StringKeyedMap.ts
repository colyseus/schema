import { Schema, type, MapSchema } from "../../../src";

export class Item extends Schema {
    @type("string") name: string;
}

// Same shape as `KeyedDecorator` in NumberKeyedMap.ts, but without any `key`:
// what every target emitted before typed map keys existed.
export class KeyedControl extends Schema {
    @type({ map: Item }) byName = new MapSchema<Item>();
    @type({ map: Item }) byId = new MapSchema<Item>();
    @type({ map: "number" }) scores = new MapSchema<number>();
}
