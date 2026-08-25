import { Schema, type, ArraySchema } from "../src";

export class Item extends Schema {
  @type("number") value: number;
}

export class Player extends Schema {
  @type("string") name: string;
  @type("number") x: number;
  @type("number") y: number;
}

export class ArraySchemaInsertOps extends Schema {
  @type(["number"]) numbers = new ArraySchema<number>();
  @type([Item]) items = new ArraySchema<Item>();
  @type([Player]) players = new ArraySchema<Player>();
}
