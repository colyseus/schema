import { Schema, type } from "../../../src";

export class KeywordState extends Schema {
    @type("string") class: string;
    @type("number") repeat: number;
    @type("number") normal: number;
}
