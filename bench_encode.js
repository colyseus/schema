// // Define a global Buffer class using Uint8Array
// globalThis.Buffer = class Buffer extends Uint8Array {
//   constructor(arg, byteOffset, length) {
//     if (typeof arg === 'number') {
//       super(arg);
//     } else if (ArrayBuffer.isView(arg) || arg instanceof ArrayBuffer) {
//       super(arg, byteOffset, length);
//     } else if (typeof arg === 'string') {
//       const encoder = new TextEncoder();
//       super(encoder.encode(arg).buffer);
//     } else {
//       throw new TypeError('Invalid argument for Buffer');
//     }
//   }

//   static alloc(size) {
//     return new Buffer(size);
//   }

//   static allocUnsafe(size) {
//     return new Buffer(size);
//   }

//   static from(value, encoding) {
//     if (typeof value === 'string') {
//       const encoder = new TextEncoder();
//       return new Buffer(encoder.encode(value).buffer);
//     } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
//       return new Buffer(value);
//     } else if (Array.isArray(value)) {
//       return new Buffer(new Uint8Array(value).buffer);
//     } else {
//       throw new TypeError('Invalid argument for Buffer.from');
//     }
//   }

//   fill(value, start = 0, end = this.length) {
//     for (let i = start; i < end; i++) {
//       this[i] = value;
//     }
//     return this;
//   }

//   slice(start, end) {
//     return new Buffer(super.slice(start, end));
//   }

//   copy(targetBuffer, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
//     const sourceSlice = this.subarray(sourceStart, sourceEnd);
//     targetBuffer.set(sourceSlice, targetStart);
//     return sourceSlice.length;
//   }

//   // Additional method to support Node.js compatibility if needed:
//   static allocUnsafeSlow(size) {
//     return Buffer.allocUnsafe(size);
//   }
// };

import { nanoid } from "./node_modules/nanoid/index.js";
import * as _1 from "./build/index.mjs";

var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};

class Attribute extends _1.Schema {
}
__decorate([
    (0, _1.type)("string")
], Attribute.prototype, "name", void 0);
__decorate([
    (0, _1.type)("number")
], Attribute.prototype, "value", void 0);
class Item extends _1.Schema {
    constructor() {
        super(...arguments);
        this.attributes = new _1.ArraySchema();
    }
}
__decorate([
    (0, _1.type)("number")
], Item.prototype, "price", void 0);
__decorate([
    (0, _1.type)([Attribute])
], Item.prototype, "attributes", void 0);
class Position extends _1.Schema {
}
__decorate([
    (0, _1.type)("number")
], Position.prototype, "x", void 0);
__decorate([
    (0, _1.type)("number")
], Position.prototype, "y", void 0);
class Player extends _1.Schema {
    constructor() {
        super(...arguments);
        this.position = new Position();
        this.items = new _1.MapSchema();
    }
}
__decorate([
    (0, _1.type)(Position)
], Player.prototype, "position", void 0);
__decorate([
    (0, _1.type)({ map: Item })
], Player.prototype, "items", void 0);
class State extends _1.Schema {
    constructor() {
        super(...arguments);
        this.players = new _1.MapSchema();
    }
}
__decorate([
    (0, _1.type)({ map: Player })
], State.prototype, "players", void 0);
__decorate([
    (0, _1.type)("string")
], State.prototype, "currentTurn", void 0);
const state = new State();
_1.Encoder.BUFFER_SIZE = 4096 * 4096;
const encoder = new _1.Encoder(state);
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
        state.players.set(`p-${(0, nanoid)()}`, player);
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
//# sourceMappingURL=bench_encode.js.map
