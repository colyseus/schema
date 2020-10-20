import { Schema, type } from "../src";

class StringType extends Schema {
    @type("string") fieldString: string;
}

const state = new StringType();
state.fieldString = "🚀ॐ漢字♤♧♥♢®⚔";

let bytes = state.encode();

console.log("StringTest =>");
console.log(`{ ${bytes.join(", ")} }`);
