import { type } from "../../../src";
import { BaseSchema } from "./BaseSchema";

class Inheritance extends BaseSchema {
    @type("number") x: number;
    @type("number") y: number;
}
