import { Sync, sync } from "../src/annotations";

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
  @sync('string')
  fieldString: string;

  @sync('int') // varint
  fieldNumber: number;

  @sync(Player)
  player: Player;

  @sync([ Player ])
  arrayOfPlayers: Player[];

  @sync({ map: Player })
  mapOfPlayers: { [id: string]: Player };
}
