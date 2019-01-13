import { DataChange } from './../src/annotations';
import { Sync, sync } from "../src/annotations";

export class Player extends Sync {
  @sync("string")
  name: string;

  @sync("number")
  x: number;

  @sync("number")
  y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Sync {
  @sync('string')
  fieldString: string;

  @sync('number') // varint
  fieldNumber: number;

  @sync(Player)
  player: Player;

  @sync([ Player ])
  arrayOfPlayers: Player[];

  @sync({ map: Player })
  mapOfPlayers: { [id: string]: Player };
}