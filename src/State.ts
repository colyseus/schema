import { Sync, sync } from "./annotations";

export class Player {
  @sync("string")
  name: string;

  @sync("int")
  x: number;

  @sync("int")
  y: number;
}

export class State extends Sync {
  @sync('string')
  fieldString: string;

  @sync('int') // varint
  fieldNumber: number;

  @sync(Player)
  player: Player;

  @sync([ Player ])
  players: Player[];
}
