import * as util from "node:util";
import "./symbol.shim";

import { type } from "./annotations";
// import { Reflection, ReflectionField, ReflectionType } from "./Reflection";

import { DataChange, Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

import { Encoder } from "./Encoder";
import { Decoder } from "./Decoder";
import { OPERATION } from "./spec";
import { encodeKeyValueOperation, encodeSchemaOperation } from "./changes/EncodeOperation";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";
import { $changes, $decoder, $deleteByIndex, $encoder, $getByIndex, $track } from "./changes/consts";
import { decodeKeyValueOperation, decodeSchemaOperation } from "./changes/DecodeOperation";
import { ChangeTree, Ref } from "./changes/ChangeTree";
import { Metadata } from "./Metadata";
import { Reflection } from "./Reflection";

// const timeout = setInterval(() => {}, 1000);

// function decorate({ get, set }, context: ClassAccessorDecoratorContext): ClassAccessorDecoratorResult<any, any> {
//     const field = context.name.toString();
//     // const fieldIndex = Metadata.addField(context.metadata, field, type);

//     const parent = Object.getPrototypeOf(context.metadata);

//     let lastIndex = (parent && parent[-1] as number) ?? -1;
//     lastIndex++;

//     context.metadata[field] = { type: "number" };

//     Object.defineProperty(context.metadata, lastIndex, {
//         value: field,
//         enumerable: false,
//         configurable: true,
//     });

//     Object.defineProperty(context.metadata, -1, {
//         value: lastIndex,
//         enumerable: false,
//         configurable: true
//     });

//     return {
//         init(value) { return value; },
//         get() { return get.call(this); },
//         set(value: any) { set.call(this, value); },
//     };
// }

// class Fruit {
//     @decorate accessor frutose: number = 1;
// }

// class Banana extends Fruit {
//     @decorate accessor potassium: number = 10;
// }

// class Berry extends Fruit {
//     @decorate accessor antioxidants: number = 10;
// }

// class Strawberry extends Berry {
//     @decorate accessor fiber: number = 10;
// }

// class Grape extends Berry {
//     @decorate accessor vitaminc: number = 5;
// }

// console.log("fruit:", Fruit[Symbol.metadata], Object.keys(Fruit[Symbol.metadata]));
// console.log("banana:", Banana[Symbol.metadata], Object.keys(Banana[Symbol.metadata]));
// console.log("strawberry:", Strawberry[Symbol.metadata], Object.keys(Strawberry[Symbol.metadata]));
// console.log("grape:", Grape[Symbol.metadata], Object.keys(Grape[Symbol.metadata]));

// console.log("GRAPE =>");

// function printFields(metadata) {
//     let i = 0;
//     const len = metadata[-1]
//     console.log({ len });
//     for (let i = 0; i <= len; i++) {
//         console.log("over len...", i, metadata[i])
//     }
// }

// console.log("Grape...");
// printFields(Grape[Symbol.metadata]);

// console.log("Banana...");
// printFields(Banana[Symbol.metadata]);


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

function log(message: any) {
    console.log(util.inspect(message, false, 10, true));
}

Schema[$encoder] = encodeSchemaOperation;
Schema[$decoder] = decodeSchemaOperation;

MapSchema[$encoder] = encodeKeyValueOperation;
MapSchema[$decoder] = decodeKeyValueOperation;

ArraySchema[$encoder] = encodeKeyValueOperation;
ArraySchema[$decoder] = decodeKeyValueOperation;

class Vec3 extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    @type("number") z: number;
}

// // No need to extend Schema!
// class Vec3 {
//     x: number;
//     y: number;
//     z: number;
//     constructor() {
//         // Need to initialize property descriptors
//         Schema.initialize(this);
//     }
// }
// // Define fields to encode/decode
// Metadata.setFields(Vec3, {
//     x: "number",
//     y: "number",
//     z: "number",
// });
// //
// Vec3[$track] = function (
//     changeTree: ChangeTree,
//     index: number,
//     operation: OPERATION = OPERATION.ADD
// ) {
//     changeTree.change(index, operation);
// };
// Vec3[$encoder] = encodeSchemaOperation;
// Vec3[$decoder] = decodeSchemaOperation;
// // @ts-ignore
// if (!Vec3.prototype.toJSON) { Vec3.prototype.toJSON = Schema.prototype.toJSON; }

// -------------------------------------------------------------------------------

// Vec3[$track] = function (changeTree, index) {
//     changeTree.change(0, OPERATION.ADD);
// };
// Vec3[$encoder] = function (encoder, bytes, changeTree, index, operation) {
//     encode.number(bytes, changeTree.ref.x);
//     encode.number(bytes, changeTree.ref.y);
//     encode.number(bytes, changeTree.ref.z);
// };
// Vec3[$decoder] = function (
//     decoder: Decoder<any>,
//     bytes: number[],
//     it: decode.Iterator,
//     ref: Vec3,
//     allChanges: DataChange[]
// ) {
//     ref.x = decode.number(bytes, it);
//     ref.y = decode.number(bytes, it);
//     ref.z = decode.number(bytes, it);
// };

class Base extends Schema {}

class Entity extends Schema {
    @type(Vec3) position = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

// TODO: @entity shouldn't be required here.
// (TypeContext.register() is required for inheritance support)
class Player extends Entity {
    @type(Vec3) rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
}

class State extends Schema {
    // @type({ map: Base }) players = new MapSchema<Entity>();
    @type("number") num: number = 0;
    @type("string") str = "Hello world!";
    // @type(Entity) entity = new Player().assign({
    //     position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
    //     rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
    // });
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

const state = new State();

state.entities.set("one", new Player().assign({
    position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
    rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
}));

state.entities.set("two", new Player().assign({
    position: new Vec3().assign({ x: 7, y: 8, z: 9 }),
    rotation: new Vec3().assign({ x: 2, y: 3, z: 4 }),
}));

const encoder = new Encoder(state);
const encoded = encoder.encodeAll();
console.log(`(length: ${encoded.byteLength})`, encoded);

// setTimeout(() => {
//     for (let i = 0; i < 500000; i++) {
//         encoder.encodeAll();
//     }
// }, 1000)

// // @ts-ignore
// globalThis.perform = function perform() {
//     for (let i = 0; i < 500000; i++) {
//         encoder.encodeAll();
//     }
// }

function logTime(label: string, callback: Function) {
    const time = Date.now();
    for (let i = 0; i < 500000; i++) {
        callback();
    }
    console.log(`${label}:`, Date.now() - time);
}
logTime("encode time", () => encoder.encodeAll());

process.exit();

// console.log(`encode: (${encoded.length})`, encoded);

// const encodedReflection = Reflection.encode(state, encoder.context);
// const decodedState = Reflection.decode(encodedReflection);
// const decodedState = new State();

// const decoder = new Decoder(decodedState);
// decoder.decode(encoded);

// log(decoder.root.toJSON());
// logTime("decode time", () => decoder.decode(encoded));

// console.log("changes =>", changes);

// const rotation = state.entity.rotation;
// rotation.x = 100;

// state.entity.rotation = undefined;

// const encoded2 = encoder.encode();
// console.log({ encoded2 });

// decoder.decode(encoded2);
// console.log("decoded =>", decoded.toJSON());

// console.profile();
// const time = Date.now();
// for (let i = 0; i < 300000; i++) {
//     const state = new State();
//     encoder['setRoot'](state);
//     encoder.encode();
// }
// console.log("encode time:", Date.now() - time);
// console.profileEnd();

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
