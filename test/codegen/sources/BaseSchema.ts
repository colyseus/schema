import { Schema, type } from "../../../src";

export class BaseSchema extends Schema {
    @type("number") id: number;
}
