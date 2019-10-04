import { Schema, type, ArraySchema, MapSchema } from "../src";

class MapSchemaInt8 extends Schema {
  @type("string") status: string = "Hello world";
  @type({ map: "int8" }) mapOfInt8 = new MapSchema<number>();
}

const state = new MapSchemaInt8();

state.mapOfInt8["bbb"] = 1;
state.mapOfInt8["aaa"] = 1;
state.mapOfInt8["221"] = 1;
state.mapOfInt8["021"] = 1;
state.mapOfInt8["15"] =  1;
state.mapOfInt8["10"] = 1;

let bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("MapSchemaTypes =>");
console.log(`{ ${bytes.join(", ")} }`);

state.mapOfInt8['10'] = 2;

bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("MapSchemaTypes =>");
console.log(`{ ${bytes.join(", ")} }`);
