import { Schema, type, deprecated } from "../../../src";

export class Versioned extends Schema {
    @type("string") kept: string;
    @deprecated() @type("string") old: string;
    @deprecated(false) @type("number") soft: number;
    @type("string") last: string;
}
