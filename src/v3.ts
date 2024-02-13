// import * as util from "node:util";

import { entity, type, TypeContext } from "./annotations";
import { Reflection, ReflectionField, ReflectionType } from "./Reflection";

import { Schema } from "./Schema";
import { MapSchema } from "./types/MapSchema";
import { ArraySchema } from "./types/ArraySchema";

import { Encoder } from "./Encoder";
import { Decoder } from "./Decoder";

// class Item extends Schema {
//     @type("string") accessor name: string;
// }

// class RootState extends Schema {
//     @type([Item]) accessor items = new ArraySchema<Item>();
// }

// const s = new RootState();
// s.items.push(new Item().assign({ name: "hello" }));

// const encoder = new Encoder(s);
// const encoded = encoder.encode();

// const decoder = new Decoder(new RootState());
// decoder.decode(encoded);

// process.exit();

// function log(message: any) {
//     console.log(util.inspect(message, false, 10, true));
// }

// @entity
class Vec3 extends Schema {
    @type("number") accessor x: number;
    @type("number") accessor y: number;
    @type("number") accessor z: number;
}

// @entity
class Base extends Schema {}

class Entity extends Schema {
    @type(Vec3) accessor position = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

// TODO: @entity shouldn't be required here.
// (TypeContext.register() is required for inheritance support)
@entity
class Player extends Entity {
    @type(Vec3) accessor rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

// @entity
class State extends Schema {
    // @type({ map: Base }) players = new MapSchema<Entity>();
    @type("number") accessor num: number = 0;
    @type("string") accessor str = "Hello world!";
    @type(Entity) accessor entity = new Player().assign({
        position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
        rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
    });
}

const state = new State();

const encoder = new Encoder(state);
const encoded = encoder.encode();
console.log(`encode: (${encoded.length})`, encoded);

const encodedReflection = Reflection.encode(state);
const decoded = Reflection.decode(encodedReflection);
const decoder = new Decoder(decoded);
decoder.decode(encoded);
console.log("decoded =>", decoded.toJSON());

// const time = Date.now();
// for (let i = 0; i < 200000; i++) {
//     const state = new State();
//     encoder['setRoot'](state);
//     encoder.encode();
// }
// console.log("encode time:", Date.now() - time);

// state.players.set("entity", new Entity());
// state.players.set("one", new Player());
// console.log("state:", state);
// console.log("state.players", state.players);
// console.log("state.players.one", state.players.get("one"));
// console.log("state.players.one.position", state.players.get("one").position);

// const encoder = new Encoder(state);
// // encoder.change()

// let encoded = encoder.encodeAll();
// console.log({ encoded })

// const decoder = new Decoder(new State());
// decoder.decode(encoded);
// log(decoder['root'].toJSON());

// const reflection = Reflection.encode(state);
// console.log("encoded =>", reflection);
// log(Reflection.decode(reflection))

///////...............................................
// function type (type: string) {
//     return function (_: any, context: ClassFieldDecoratorContext) {
//         context.addInitializer(function() {
//             console.log("INITIALIZER!", this);
//             setTimeout(() => {
//                 context.access.set(this, "WHAT");
//             }, 1000);
//         });

//         context.access.get = function(object) {
//             return object[context.name];
//         }

//         context.access.set = function(object, value) {
//             console.log("setter...", object, value);
//             object[context.name] = `Setter[${value}]`;
//         };

//         return function(value) {
//             console.log("SET", this, value);
//             if (typeof(value) === "string") {
//                 value = `Initializer[${value}]`;
//             } else {
//                 value = value * 100;
//             }
//             return value;
//         };
//     }
// }

// class MyState {
//     @type("string") name: string = "Hello world!";
//     @type("number") num: number = 1;
// }

// const state = new MyState();
// console.log("name: ", state.name);
// console.log("num: ", state.num);
// state.name = `${state.name} modified...`;
// setTimeout(() => console.log(state.name), 1100);