import { Schema, type } from "../../../src";

export abstract class Component extends Schema {
}

export class MyComponent extends Schema {
    @type("number") field: number;
}
