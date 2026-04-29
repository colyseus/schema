import * as assert from "assert";

import { Schema, type, ArraySchema, MapSchema, Reflection, Iterator, StateView, view } from "../src";
import { Decoder } from "../src/decoder/Decoder";
import { Encoder } from "../src/encoder/Encoder";
import { CallbackProxy, getDecoderStateCallbacks, SchemaCallbackProxy } from "../src/decoder/strategy/getDecoderStateCallbacks";

// augment Schema to add encode/decode methods
// (workaround to keep tests working while we don't migrate the tests to the new API)
declare module "../src/Schema" {
  interface Schema {
    encode(it?: Iterator): Uint8Array;
    encodeAll(): Uint8Array;
    decode(bytes: Uint8Array): void;
  }
}


export function getCallbacks<T extends Schema>(state: T): (<F extends Schema>(instance: F) => CallbackProxy<F>) {
    return getDecoderStateCallbacks(getDecoder(state));
}

export function getDecoder<T extends Schema>(state: T) {
    // @ts-ignore
    if (!state['_decoder']) { state['_decoder'] = new Decoder(state); }
    // @ts-ignore
    return state['_decoder'] as Decoder<T>;
}

export function encodeAndAssertEquals<T extends Schema>(state: T, decodedState: T) {
    const encoded = state.encode();
    decodedState.decode(encoded);
    assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
}

/**
 * This assertion simulates a new client joining the room, and receiving the initial state.
 */
export function assertDeepStrictEqualEncodeAll<T extends Schema>(state: T, assetRefIds: boolean = true) {
    const freshDecode = createInstanceFromReflection(state);
    const encodeAll = state.encodeAll();
    freshDecode.decode(encodeAll);
    assert.deepStrictEqual(freshDecode.toJSON(), state.toJSON());

    // assert ref counts
    if (assetRefIds) {
        assertRefIdCounts(state, freshDecode);
    }

    // // perform a regular encode right full decode
    // freshDecode.decode(state.encode());
    // assert.deepStrictEqual(freshDecode.toJSON(), state.toJSON());
}

export function assertRefIdCounts<T extends Schema>(source: T, target: T) {
    // assert ref counts
    const encoder = getEncoder(source);
    const decoder = getDecoder(target);

    for (const refId in encoder.root.refCount) {
        const ref = encoder.root.changeTrees[refId]?.ref;
        const encoderRefCount = encoder.root.refCount[refId];
        const decoderRefCount = decoder.root.refCount[refId] ?? 0;
        assert.strictEqual(encoderRefCount, decoderRefCount, `refCount mismatch for '${ref?.constructor.name}' (refId: ${refId}) => (Encoder count: ${encoderRefCount}, Decoder count: ${decoderRefCount})
\n${Schema.debugRefIds(source)}`);
    }
}

export function getEncoder<T extends Schema>(state: T) {
    // @ts-ignore
    if (!state['_encoder']) { state['_encoder'] = new Encoder(state); }
    // @ts-ignore
    return state['_encoder'] as Encoder;
}

export function createInstanceFromReflection<T extends Schema>(state: T, encoder?: Encoder<T>) {
    encoder ??= getEncoder(state);
    const decoder = Reflection.decode<T>(Reflection.encode(encoder));
    // @ts-ignore
    decoder.state['_decoder'] = decoder;
    return decoder.state;
}

Schema.prototype.encode = function(it: Iterator) {
    const encoder = getEncoder(this);
    const bytes = encoder.encode(it);
    encoder.discardChanges();
    return bytes;
}

Schema.prototype.decode = function(bytes: Uint8Array) {
    return getDecoder(this).decode(bytes);
}

Schema.prototype.encodeAll = function() {
    return getEncoder(this).encodeAll();
}

export interface ClientWithState<T extends Schema> {
    state: T;
    view: StateView;
    decoder: Decoder<T>;
    $: SchemaCallbackProxy<T>;
    needFullEncode: boolean;
}

export function createClientWithView<T extends Schema>(from: T, stateView: StateView = new StateView(), encoder?: Encoder): ClientWithState<T> {
    const state = createInstanceFromReflection(from, encoder);
    const decoder = getDecoder(state);
    return {
        state,
        view: stateView,
        decoder,
        $: getDecoderStateCallbacks(decoder),
        needFullEncode: true,
    };
}

export function encodeAllForView<T extends Schema>(encoder: Encoder<T>, client: ClientWithState<T>, printEncodeAll?: boolean) {
    const buf = new Uint8Array(4096);
    const itAll = { offset: 0 };
    const fullEncode = encoder.encodeAll(itAll, buf);

    // console.log(`FULL ENCODE: (${fullEncode.length})`, Array.from(fullEncode));

    if (printEncodeAll) {
        const tmpState = createInstanceFromReflection(client.state);
        tmpState.decode(fullEncode);
        console.log("TMP STATE =>", tmpState);
        console.log({ fullEncode: Array.from(fullEncode) });
    }

    const sharedOffset = itAll.offset;
    const fullEncodeForView = encoder.encodeAllView(client.view, sharedOffset, itAll, buf);

    // console.log(`FULL ENCODE FOR VIEW: (${fullEncodeForView.length})`, Array.from(fullEncodeForView));

    client.state.decode(fullEncodeForView);
    client.needFullEncode = false;
}

export function encodeMultiple<T extends Schema>(encoder: Encoder<T>, state: T, clients: Array<ClientWithState<T>>) {
    // console.log("---- ENCODE MULTIPLE ----");

    // check if "encode all" is needed for each client.
    clients.map((client, i) => {
        // construct state if needed
        if (!client.state) { client.state = createInstanceFromReflection(state); }

        // decode full state if needed
        if (client.needFullEncode) {
            // console.log("> encodeAllForView()");
            encodeAllForView(encoder, client);
        }
    });

    const it = { offset: 0 };

    // perform shared encode
    // console.log("\n\n\n\n>> SHARED ENCODE!");
    encoder.encode(it);

    const sharedOffset = it.offset;
    const encodedViews = clients.map((client, i) => {
        // encode each view
        // console.log(">> encodeView()", i + 1);
        const encoded = encoder.encodeView(client.view, sharedOffset, it);
        client.state.decode(encoded);
        return encoded;
    });

    encoder.discardChanges();
    return encodedViews;
}

export function encodeAllMultiple<T extends Schema>(encoder: Encoder<T>, state: T, referenceClients: Array<{ state: Schema, view: StateView }>) {
    const clients = referenceClients.map((client) => createClientWithView(state, client.view));

    const it = { offset: 0 };

    // perform shared encode
    encoder.encodeAll(it);

    const sharedOffset = it.offset;
    const encodedViews = clients.map((client, i) => {
        if (!client.state) {
            client.state = createInstanceFromReflection(state);
        }

        // encode each view
        // console.log(`> ENCODE VIEW: client${i + 1}`);

        const encoded = encoder.encodeAllView(client.view, sharedOffset, it);
        client.state.decode(encoded);

        return encoded;
    });

    return { clients, encodedViews };
}

export function assertEncodeAllMultiple<T extends Schema>(encoder: Encoder<T>, state: T, referenceClients: Array<{ state: Schema, view: StateView }>) {
    const { clients, encodedViews } = encodeAllMultiple(encoder, state, referenceClients);

    referenceClients.forEach((referenceClient, i) => {
        assert.deepStrictEqual(referenceClient.state.toJSON(), clients[i].state.toJSON(), `client${i + 1} state mismatch`);
    });

    return encodedViews;
}

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

export class InheritanceParent extends Schema {
    @type(Position) standardChild: Position | undefined = undefined;
    @view() @type(Position) viewChild: Position | undefined = undefined;
    @type([Position]) arrayChild: ArraySchema<Position> = new ArraySchema<Position>();
}

export class InheritanceRoot extends Schema {
    @view() @type(InheritanceParent) parent = new InheritanceParent();
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
