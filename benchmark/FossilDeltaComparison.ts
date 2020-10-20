import { Schema, type } from "../src";
import { nanoid } from "nanoid";
import * as msgpack from "@msgpack/msgpack";
import * as fossildelta from "fossil-delta";
import { MapSchema } from "../src/types/MapSchema";

export class Player extends Schema {
  @type("string")
  name: string;

  @type("number")
  x: number;

  @type("number")
  y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();

    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Schema {
  @type({ map: Player })
  players = new MapSchema<Player>();
}

const state = new State();


let msgpackState = { players: {} };

const fixedUnitId = nanoid(9);

for (let i=0; i<100; i++) {
  const id = (i === 50) ? fixedUnitId : nanoid(9);
  const name = "Player " + i;
  const x = Math.floor(Math.random() * 200);
  const y = Math.floor(Math.random() * 200);
  state.players[ id ] = new Player(name, x, y);
  msgpackState.players[id] = { name, x, y };
}

const firstStateEncoded = msgpack.encode(msgpackState);
let encoded = state.encode();

const decodedState = new State();
decodedState.decode(encoded);

console.log("(@colyseus/state) INITIAL STATE SIZE:", encoded.length);
console.log("(msgpack) INITIAL STATE SIZE:", firstStateEncoded.length);
console.log("");

// {
//   // CHANGE X/Y OF A SINGLE ENTITY
//   const x = Math.floor(Math.random() * 200);
//   const y = Math.floor(Math.random() * 200);
//   state.players[fixedUnitId].x = x
//   state.players[fixedUnitId].y = y
//   msgpackState.players[fixedUnitId].x = x
//   msgpackState.players[fixedUnitId].y = y
// }

// {
//   // CHANGE X/Y OF 50 ENTITIES
//   let i = 0;
//   for (let id in msgpackState.players) {
//     if (i > 50) break;
//     const x = Math.floor(Math.random() * 200);
//     const y = Math.floor(Math.random() * 200);
//     state.players[id].x = x
//     state.players[id].y = y
//     msgpackState.players[id].x = x
//     msgpackState.players[id].y = y
//     i++;
//   }
// }

{
  // CHANGE ALL X/Y VALUES
  let i = 0;
  for (let id in msgpackState.players) {
    const x = Math.floor(Math.random() * 200);
    const y = Math.floor(Math.random() * 200);
    state.players[id].x = x
    state.players[id].y = y
    msgpackState.players[id].x = x
    msgpackState.players[id].y = y
    i++;
  }
}

encoded = state.encode();
decodedState.decode(encoded);

console.log("(@colyseus/state) SUBSEQUENT PATCH:", encoded.length);
console.log("(msgpack) SUBSEQUENT PATCH:", fossildelta.create(firstStateEncoded, msgpack.encode(msgpackState)).length);
