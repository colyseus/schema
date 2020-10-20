import { Schema, type, ArraySchema, MapSchema, filter } from "../src";

// interface IUser {
//     name: string;
// }

// interface ResponseMessage {
//     user: IUser,
//     str: string;
//     n: number;
//     shortcode: {[id: string]: string};
// }

/**
 * No filters example
 */
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
  @type('string')
  fieldString: string;

  @type('number') // varint
  fieldNumber: number;

  @type(Player)
  player: Player;

  @type([ Player ])
  arrayOfPlayers: ArraySchema<Player>;

  @type({ map: Player })
  mapOfPlayers: MapSchema<Player>;
}

/**
 * Deep example
 */
export class Position extends Schema {
  @type("float32") x: number;
  @type("float32") y: number;
  @type("float32") z: number;

  constructor (x: number, y: number, z: number) {
    super();
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

export class Another extends Schema {
  @type(Position)
  position: Position = new Position(0, 0, 0);
}

export class DeepEntity extends Schema {
  @type("string")
  name: string;

  @type(Another)
  another: Another = new Another();
}

export class DeepEntity2 extends DeepEntity {
}

export class DeepChild extends Schema {
  @type(DeepEntity)
  entity = new DeepEntity();
}

export class DeepMap extends Schema {
  @type([DeepChild])
  arrayOfChildren = new ArraySchema<DeepChild>();
}

export class DeepState extends Schema {
  @type({ map: DeepMap })
  map = new MapSchema<DeepMap>();
}
