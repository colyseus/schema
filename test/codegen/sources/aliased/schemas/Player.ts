import { Schema, type } from "../../../../../src";

export class AliasedPlayer extends Schema {
    @type("string") name: string;
}
