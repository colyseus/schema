import { Schema, type, MapSchema } from "../src";

class State extends Schema {
    @type({ map: "number" }) previous: MapSchema<number>;
    @type({ map: "number" }) current: MapSchema<number>;
}

const state = new State();
let bytes: number[];

state.current = new MapSchema<number>();
state.current.set("0", 0);
state.previous = null;

bytes = Array.from(Uint8Array.from(Buffer.from(state.encode())));
console.log("MapSchemaMoveNullifyType =>");
console.log(`{ ${bytes.join(", ")} }`);

state.previous = state.current;
state.current = null;

bytes = Array.from(Uint8Array.from(Buffer.from(state.encode())));
console.log("MapSchemaMoveNullifyType =>");
console.log(`{ ${bytes.join(", ")} }`);