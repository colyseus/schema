import { nanoid } from "nanoid";
import { Schema, type, MapSchema, ArraySchema, Encoder } from "./index";

class Attribute extends Schema {
    @type("string") name: string;
    @type("number") value: number;
}

class Item extends Schema {
    @type("number") price: number;
    @type([ Attribute ]) attributes = new ArraySchema<Attribute>();
}

class Position extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}

class Player extends Schema {
    @type(Position) position = new Position();
    @type({ map: Item }) items = new MapSchema<Item>();
}

class State extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
    @type("string") currentTurn: string;
}

const state = new State();

Encoder.BUFFER_SIZE = 4096 * 4096;
const encoder = new Encoder(state);


let now = Date.now();

// for (let i = 0; i < 10000; i++) {
//     const player = new Player();
//     state.players.set(`p-${nanoid()}`, player);
//
//     player.position.x = (i + 1) * 100;
//     player.position.y = (i + 1) * 100;
//     for (let j = 0; j < 10; j++) {
//         const item = new Item();
//         player.items.set(`item-${j}`, item);
//         item.price = (i + 1) * 50;
//         for (let k = 0; k < 5; k++) {
//             const attr = new Attribute();
//             attr.name = `Attribute ${k}`;
//             attr.value = k;
//             item.attributes.push(attr);
//         }
//     }
// }
// console.log("time to make changes:", Date.now() - now);


// measure time to .encodeAll()

now = Date.now();
// for (let i = 0; i < 1000; i++) {
//     encoder.encodeAll();
// }
// console.log(Date.now() - now);

const total = 100;
const allEncodes = Date.now();

let avgTimeToEncode = 0;
let avgTimeToMakeChanges = 0;

for (let i = 0; i < total; i++) {
    now = Date.now();
    for (let j = 0; j < 50; j++) {
        const player = new Player();
        state.players.set(`p-${nanoid()}`, player);

        player.position.x = (j + 1) * 100;
        player.position.y = (j + 1) * 100;
        for (let k = 0; k < 10; k++) {
            const item = new Item();
            item.price = (j + 1) * 50;
            for (let l = 0; l < 5; l++) {
                const attr = new Attribute();
                attr.name = `Attribute ${l}`;
                attr.value = l;
                item.attributes.push(attr);
            }
            player.items.set(`item-${k}`, item);
        }
    }
    const timeToMakeChanges = Date.now() - now;
    console.log("time to make changes:", timeToMakeChanges);
    avgTimeToMakeChanges += timeToMakeChanges;

    now = Date.now();
    encoder.encode();
    encoder.discardChanges();

    const timeToEncode = Date.now() - now;
    console.log("time to encode:", timeToEncode);
    avgTimeToEncode += timeToEncode;
}
console.log("avg time to encode:", (avgTimeToEncode) / total);
console.log("avg time to make changes:", (avgTimeToMakeChanges) / total);
console.log("time for all encodes:", Date.now() - allEncodes);

console.log(Array.from(encoder.encodeAll()).length, "bytes");
