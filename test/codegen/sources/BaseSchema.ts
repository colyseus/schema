import { Schema, type } from "../../../src";

export class BaseSchema<T=any> extends Schema {
    @type("number") id: number;
}
