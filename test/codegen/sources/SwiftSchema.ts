import { Schema, type, ArraySchema, MapSchema } from "../../../src";

export class Item extends Schema {
    @type("string") name: string;
    @type("number") value: number;
}

export class Player extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    @type("boolean") isBot: boolean;
    @type([Item]) items = new ArraySchema<Item>();
    @type({ map: "number" }) scores = new MapSchema<number>();
    @type(["string"]) tags = new ArraySchema<string>();
}

export class TestRoomState extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
    @type(Player) host: Player;
    @type("string") currentTurn: string;
}
