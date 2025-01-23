import { Schema, type, ArraySchema, Encoder } from "../src";

class ArraySchemaClear extends Schema {
  @type(["number"]) items = new ArraySchema<number>();
}

const state = new ArraySchemaClear();
const encoder = new Encoder(state);

// add 5 items
state.items.push(1);
state.items.push(2);
state.items.push(3);
state.items.push(4);
state.items.push(5);

const encoded = encoder.encode();
let bytes = Array.from(Uint8Array.from(Buffer.from(encoded)));

console.log("ArraySchemaClear =>");
console.log(`{ ${bytes.join(", ")} }`);

// clear items
state.items.clear();
bytes = Array.from(Uint8Array.from(Buffer.from( encoder.encode() )));

console.log("ArraySchemaClear =>");
console.log(`{ ${bytes.join(", ")} }`);

// add 5 items again
state.items.push(1);
state.items.push(2);
state.items.push(3);
state.items.push(4);
state.items.push(5);

bytes = Array.from(Uint8Array.from(Buffer.from( encoder.encode() )));

console.log("ArraySchemaClear =>");
console.log(`{ ${bytes.join(", ")} }`);
