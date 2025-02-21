import { Schema, type, MapSchema, TypeContext } from "../src";
import * as assert from "assert";
import { entity } from "../src/annotations";

describe("TypeContext", () => {
    it("should register all inherited classes", () => {
        class Pokemon extends Schema {
            @type("string") name: string;
        }

        class Unown extends Pokemon {
            @type("number") power: number;
        }

        @entity class UnownA extends Unown {}
        @entity class UnownB extends Unown {}

        class MyState extends Schema {
            @type({ map: Pokemon }) pokemons = new MapSchema<Pokemon>();
        }

        const context = new TypeContext(MyState);

        assert.strictEqual(context.schemas.size, 5);
    })

});
