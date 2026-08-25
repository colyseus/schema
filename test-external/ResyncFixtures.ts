import { Schema, type, ArraySchema, MapSchema } from "../src";

//
// Client-side fixture classes for the decodeResync SDK ports.
// Server-only variants (@view / @transient / V2 version-skew) are defined
// inside generate-resync-fixtures.ts — they are wire-compatible with these.
//

export class Gem extends Schema {
  @type("number") price: number;
}

export class Unit extends Schema {
  @type("string") name: string;
  @type("number") hp: number;
  @type([Gem]) gems = new ArraySchema<Gem>();
}

export class ResyncState extends Schema {
  @type({ map: Unit }) units = new MapSchema<Unit>();
  @type({ map: "number" }) trees = new MapSchema<number>();
}

export class ResyncArrayState extends Schema {
  @type([Unit]) arr = new ArraySchema<Unit>();
}

export class ResyncPlayerV1 extends Schema {
  @type("number") x: number;
}

export class ResyncStateV1 extends Schema {
  @type({ map: ResyncPlayerV1 }) players = new MapSchema<ResyncPlayerV1>();
}

export class ResyncTransientState extends Schema {
  @type({ map: Unit }) units = new MapSchema<Unit>();
  @type({ map: "number" }) locals = new MapSchema<number>();
}
