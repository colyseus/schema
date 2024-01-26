import * as util from "util";
import { MapSchema, Reflection, Schema, TypeContext, type } from "./src";
import { Encoder } from "./src/Encoder";
import { Decoder } from "./src/Decoder";

function log(message: any) {
    console.log(util.inspect(message, false, 10, true));
}

class Vec3 extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    @type("number") z: number;
}

class Base extends Schema {}

class Entity extends Base {
    @type(Vec3) position = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

class Player extends Entity {
    @type(Vec3) rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

class State extends Schema {
    @type({ map: Base }) players = new MapSchema<Entity>();
}

const state = new State();
state.players.set("entity", new Entity());
state.players.set("one", new Player());

const encoder = new Encoder(state);
// encoder.change()

let encoded = encoder.encodeAll();

const decoder = new Decoder(new State());
decoder.decode(encoded);
log(decoder['root'].toJSON());

const reflection = Reflection.encode(state);
console.log("encoded =>", reflection);
log(Reflection.decode(reflection))