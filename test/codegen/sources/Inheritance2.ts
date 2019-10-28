import { type } from "../../../src";
import { BaseSchema } from "./BaseSchema";

class Inheritance2 extends BaseSchema<any> {
    @type("number") x: number;
    @type("number") y: number;
}
