import { Schema, type, ArraySchema, MapSchema, filter } from "../src";

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
export class DeepChild extends Schema {
  @type(Player)
  player: Player = new Player();
}

export class DeepMap extends Schema {
  @type([DeepChild])
  arrayOfChildren = new ArraySchema<DeepChild>();
}

export class DeepState extends Schema {
  @type({ map: DeepMap })
  map = new MapSchema<DeepMap>();
}


/**
 * Filters example
 */
export class Inventory extends Schema {
  @type("number")
  items: number;
}

export class Unit extends Schema {
  @type("number")
  x: number;

  @type("number")
  y: number;

  @filter(function(client: any, value: Inventory, root: StateWithFilter) {
    return root.units[client.sessionId] === this;
  })
  @type(Inventory)
  inventory: Inventory;
}

export class Bullet extends Schema {
  @type("number")
  x: number;

  @type("number")
  y: number;
}

const filters = {
  byDistance: function(this: StateWithFilter, client: any, value: Player | Bullet) {
    const currentPlayer = this.unitsWithDistanceFilter[client.sessionId]

    var a = value.x - currentPlayer.x;
    var b = value.y - currentPlayer.y;

    return (Math.sqrt(a * a + b * b)) <= 10;
  }
}

export class StateWithFilter extends Schema {
  @type("string")
  unfilteredString: string;

  @type({ map: Unit })
  units = new MapSchema<Unit>();

  @type({ map: Bullet })
  bullets: MapSchema<Bullet>;

  @filter(filters.byDistance)
  @type({ map: Unit })
  unitsWithDistanceFilter = new MapSchema<Unit>();

  @type("string")
  unfilteredString2: string;

  @filter(function(client: any) {
    return client.sessionId === "one";
  })
  @type("number")
  filteredNumber: number;
}