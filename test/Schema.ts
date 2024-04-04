import { Schema, type, ArraySchema, MapSchema, Reflection, Iterator } from "../src";
import { Decoder } from "../src/decoder/Decoder";
import { Encoder } from "../src/encoder/Encoder";
import { getStateCallbacks } from "../src/decoder/strategy/StateCallbacks";

// augment Schema to add encode/decode methods
// (workaround to keep tests working while we don't migrate the tests to the new API)
declare module "../src/Schema" {
  interface Schema {
    encode(it?: Iterator): Buffer;
    encodeAll(): Buffer;
    decode(bytes: Buffer): void;
  }
}

export function getCallbacks(state: Schema) {
    return getStateCallbacks(getDecoder(state));
}

export function getDecoder(state: Schema) {
    if (!state['_decoder']) { state['_decoder'] = new Decoder(state); }
    return state['_decoder'] as Decoder;
}

export function getEncoder(state: Schema) {
    if (!state['_encoder']) { state['_encoder'] = new Encoder(state); }
    return state['_encoder'] as Encoder;
}

export function createInstanceFromReflection<T extends Schema>(state: T) {
    return Reflection.decode<T>(Reflection.encode(state, getEncoder(state).context))
}

Schema.prototype.encode = function(it: Iterator) {
    const encoder = getEncoder(this);
    const bytes = encoder.encode(it);
    encoder.discardChanges();
    return bytes;
}

Schema.prototype.decode = function(bytes: Buffer) {
    return getDecoder(this).decode(bytes);
}

Schema.prototype.encodeAll = function() {
    return getEncoder(this).encodeAll();
}

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
  @type("string") name: string;
  @type("number") x: number;
  @type("number") y: number;

  constructor (name?: string, x?: number, y?: number) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
  }
}

export class State extends Schema {
  @type('string') fieldString: string;
  @type('number') fieldNumber: number;
  @type(Player) player: Player;
  @type([ Player ]) arrayOfPlayers: ArraySchema<Player>;
  @type({ map: Player }) mapOfPlayers: MapSchema<Player>;
}

/**
 * Deep example
 */
export class Position extends Schema {
    @type("float32") x: number;
    @type("float32") y: number;
    @type("float32") z: number;

    constructor(x: number, y: number, z: number) {
        super();
        this.x = x;
        this.y = y;
        this.z = z;
    }
}

export class Another extends Schema {
    @type(Position) position: Position = new Position(0, 0, 0);
}

export class DeepEntity extends Schema {
    @type("string") name: string;
    @type(Another) another: Another = new Another();
}

export class DeepEntity2 extends DeepEntity { }

export class DeepChild extends Schema {
    @type(DeepEntity) entity = new DeepEntity();
}

export class DeepMap extends Schema {
    @type([DeepChild]) arrayOfChildren = new ArraySchema<DeepChild>();
}

export class DeepState extends Schema {
    @type({ map: DeepMap }) map = new MapSchema<DeepMap>();
}
