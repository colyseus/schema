import { Sync, sync } from "../src/annotations";
import * as nanoid from "nanoid";
import * as msgpack from "notepack.io";
import * as fossildelta from "fossil-delta";

export class Player extends Sync {
  @sync("string")
  name: string;

  @sync("int")
  x: number;

  @sync("int")
  y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();

    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Sync {
  @sync({ map: Player })
  players: { [id: string]: Player };
}

const state = new State();
state.players = {};


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

state.players[fixedUnitId].x = Math.floor(Math.random() * 200);
state.players[fixedUnitId].y = Math.floor(Math.random() * 200);

msgpackState.players[fixedUnitId].x = state.players[fixedUnitId].x;
msgpackState.players[fixedUnitId].y = state.players[fixedUnitId].y;

encoded = state.encode();
decodedState.decode(encoded);

console.log("(@colyseus/state) SUBSEQUENT PATCH:", encoded.length);
console.log("(msgpack) SUBSEQUENT PATCH:", fossildelta.create(firstStateEncoded, msgpack.encode(msgpackState)).length);
