import * as util from "node:util";
import "./symbol.shim";

import { owned, type } from "./annotations";
// import { Reflection, ReflectionField, ReflectionType } from "./Reflection";

import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

import { Encoder } from "./encoder/Encoder";
import { Decoder } from "./decoder/Decoder";
import { OPERATION } from "./encoding/spec";
import { encodeKeyValueOperation, encodeSchemaOperation, encodeValue } from "./encoder/EncodeOperation";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";
import { $changes, $decoder, $deleteByIndex, $encoder, $getByIndex, $track } from "./types/symbols";
import { decodeKeyValueOperation, decodeSchemaOperation } from "./decoder/DecodeOperation";
import { ChangeTree, Ref } from "./encoder/ChangeTree";
import { Metadata } from "./Metadata";
import { Reflection } from "./Reflection";
import { StateView } from "./encoder/StateView";
import { getStateCallbacks } from "./decoder/strategy/StateCallbacks";
import { getRawChangesCallback } from "./decoder/strategy/RawChanges";

const $callback = {
    $onCreate: Symbol('$onCreate'),
    $onDelete: Symbol('$onDelete'),
    $onUpdate: Symbol('$onUpdate'),
}

function logSingleCall(label: string, callback: Function) {
    const time = Date.now();
    const res = callback();
    console.log(`${label}:`, Date.now() - time);
    return res;
}

function logTime(label: string, callback: Function) {
    const time = Date.now();
    for (let i = 0; i < 500000; i++) {
        callback();
    }
    console.log(`${label}:`, Date.now() - time);
}


// // @ts-ignore
// globalThis.perform = function perform() {
//     for (let i = 0; i < 500000; i++) {
//         encoder.encodeAll();
//     }
// }

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

function log(message: any) {
    console.log(util.inspect(message, false, 10, true));
}

Schema[$encoder] = encodeSchemaOperation;
Schema[$decoder] = decodeSchemaOperation;

MapSchema[$encoder] = encodeKeyValueOperation;
MapSchema[$decoder] = decodeKeyValueOperation;

ArraySchema[$encoder] = encodeKeyValueOperation;
ArraySchema[$decoder] = decodeKeyValueOperation;

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

class Vec3 extends Schema {
    @type("number") x: number;
    @type("number") y: number;
    @type("number") z: number;
}
// Vec3[$track] = function (changeTree, index) {
//     changeTree.change(0, OPERATION.ADD);
// };
// Vec3[$encoder] = function (encoder, bytes, changeTree, index, operation, it) {
//     encode.number(bytes, changeTree.ref.x, it);
//     encode.number(bytes, changeTree.ref.y, it);
//     encode.number(bytes, changeTree.ref.z, it);
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

class Card extends Schema {
    @type("string") suit: string;
    @type("number") num: number;
}

class Player extends Entity {
    @type(Vec3) rotation = new Vec3().assign({ x: 0, y: 0, z: 0 });
    @type("string") secret: string = "private info only for this player";

    @type([Card])
    cards = new ArraySchema<Card>(
        new Card().assign({ suit: "Hearts", num: 1 }),
        new Card().assign({ suit: "Spaces", num: 2 }),
        new Card().assign({ suit: "Diamonds", num: 3 }),
    );

    [$callback.$onCreate]() {
    }

}

class Team extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

class State extends Schema {
    @type("number") num: number = 0;
    @type("string") str = "Hello world!"

    @owned @type([Team]) teams = new ArraySchema<Team>();



    // @type({ map: Entity }) entities = new MapSchema<Entity>();

    // @type(Entity) entity1 = new Player().assign({
    //     position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
    //     rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
    // });
    // @type(Entity) entity2 = new Player().assign({
    //     position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
    //     rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
    // });
}

const state = new State();

// for (let i=0;i<1000;i++) {
//     state.entities.set("one" + i, new Player().assign({
//         position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
//         rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
//     }));
// }

// state.entities.set("one", new Player().assign({
//     position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
//     rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
// }));

// state.entities.set("two", new Player().assign({
//     position: new Vec3().assign({ x: 10, y: 10, z: 3 }),
//     rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
// }));

function addTeam() {
    const team = new Team();
    team.entities.set("one", new Player().assign({
        position: new Vec3().assign({ x: 1, y: 2, z: 3 }),
        rotation: new Vec3().assign({ x: 4, y: 5, z: 6 }),
    }));
    team.entities.set("two", new Player().assign({
        position: new Vec3().assign({ x: 7, y: 8, z: 9 }),
        rotation: new Vec3().assign({ x: 2, y: 3, z: 4 }),
    }));
    state.teams.push(team);
}

addTeam();
addTeam();

const it = { offset: 0 };

const encoder = new Encoder(state);
// logTime("encode time", () => encoder.encodeAll());

// const encoded = encoder.encode(it);

console.log("> will encode all...", state.toJSON());
const encoded = encoder.encode(it);

console.log("HEAP TOTAL:", process.memoryUsage().heapTotal / 1024 / 1024, "MB");
console.log("HEAP USED:", process.memoryUsage().heapUsed / 1024 / 1024, "MB");

// console.log("encoded.buffer =>", `(${encoded.byteLength} bytes)`);

const sharedOffset = it.offset;

// const team1View = new StateView<State>();
// team1View.owns(state.teams[0]);

const view = new StateView();
view.owns(state.teams[0]);

// view1['owned'].add(state[$changes]);
// view1['owned'].add(state.teams[$changes]);
// view1.owns(state.teams[0]);
// view1.owns(state.entities);
// view1.owns(state.entities.get("one"));

const view2 = new StateView<State>();
console.log(">>> VIEW 2");
view2.owns(state.teams[1]);
// view2.owns(state.entities.get("two"));

console.log("> will encode view 1...");
const viewEncoded1 = encoder.encodeView(view, sharedOffset, it, encoder.sharedBuffer);
console.log("done. view1 encoded =>", `(${viewEncoded1.byteLength} bytes)`);

console.log("> will encode view 2...");
const viewEncoded2 = encoder.encodeView(view2, sharedOffset, it, encoder.sharedBuffer);
console.log("done. view2 encoded =>", `(${viewEncoded2.byteLength} bytes)`);

// setTimeout(() => {
//     for (let i = 0; i < 500000; i++) {
//         encoder.encodeAll();
//     }
// }, 1000)

// logTime("encode time", () => encoder.encodeAll());

// console.log(`encode: (${encoded.length})`, encoded);

console.log("----------------------------------- ENCODE reflection...");
const encodedReflection = Reflection.encode(state, encoder.context);
console.log("----------------------------------- DECODE reflection...");
const decodedState = Reflection.decode<State>(encodedReflection);

// const decodedState = new State();
const decoder = new Decoder(decodedState);

// room.$.teams.onAdd((team, index) => {
//     team.$.entities.onAdd((entity, entityId) => {
//         entity.$.position.onChange(() => {
//         });
//     });
// });

const { $ } = getStateCallbacks(decoder); // room

console.log("> register callbacks...");

const s: any = {};

$(decoder.state).listen("str", (value, previousValue) => {
    console.log("'str' changed:", { value, previousValue });
});

$(decoder.state).teams.onAdd((team, index) => { // delayed
    console.log("Teams.onAdd =>", { index, refId: decoder.$root.refIds.get(team) });

    $(team).entities.onAdd((entity, entityId) => {
        console.log(`Entities.onAdd =>`, { teamIndex: index, entityId, refId: decoder.$root.refIds.get(entity) });

        // $(entity as Player).cards.onAdd((card, cardIndex) => {
        //     console.log(entityId, "card added =>", { card, cardIndex });
        // });

        // const frontendObj: any = {};
        // $(entity).position.bindTo(frontendObj, ["x", "y", "z"]);
    }, false);

    // $(team).entities.get("one").position.listen("x", (value, previousValue) => {
    // });

});

// $(decoder.state).teams.onAdd((team, index) => {
//     // room.$state.bind(team, frontendTeam);
//     $(team).entities.onAdd((entity, entityId) => {
//         $(entity as Player).listen("secret", (value, previousValue) => {
//         });

//         $(entity).position.onChange(() => {
//         });
//     });
// });


console.log("> will decode...");

// decoder.decode(encoded);
const changes = decoder.decode(viewEncoded1);

console.log("Decoded =>", decoder.state.toJSON());

// decoder.decode(viewEncoded2);

// log(decodedState.toJSON());

// console.log("encoder.$root.changes =>", encoder.$root.changes.length);
// console.log("encoder.$root.filteredChanges =>", encoder.$root.filteredChanges.length);

// state.teams[0].entities.get("one").position.x = 100;

// // encoder.

// const it2 = { offset: 0 };
// // const encoded = encoder.encode(it);
// const encoded2 = encoder.encode(it2);
// console.log(`> shared encode... (${encoded2.byteLength} bytes)`);

// const viewEncoded3 = encoder.encodeView(view1, sharedOffset, it, encoder.sharedBuffer);
// console.log(`> view1... (${viewEncoded3.byteLength} bytes)`);


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
