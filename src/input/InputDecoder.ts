import { Decoder } from "../decoder/Decoder.js";
import { decode, type Iterator } from "../encoding/decode.js";
import type { Schema } from "../Schema.js";

/**
 * Bound single-struct decoder for input packets. Wraps the standard
 * `Decoder` so bytes emitted by `InputEncoder` land on the bound instance.
 *
 * - `decode(bytes)`: single-input packet (reliable mode).
 * - `decodeAll(bytes, cb)`: multi-input length-framed packet (unreliable
 *   mode). Invokes `cb` with the mutated instance once per framed input,
 *   oldest → newest. The instance is re-used across callbacks — consume
 *   synchronously (apply to game state) rather than holding the reference.
 */
export class InputDecoder<T extends Schema = any> {
    readonly instance: T;
    private readonly _decoder: Decoder<T>;
    private readonly _it: Iterator = { offset: 0 };

    constructor(instance: T) {
        this.instance = instance;
        this._decoder = new Decoder(instance);
    }

    /**
     * Decode a single-input (reliable) packet into the bound instance.
     * Returns the instance for chaining.
     */
    decode(bytes: Uint8Array): T {
        this._decoder.decode(bytes);
        return this.instance;
    }

    /**
     * Walk a multi-input (unreliable) packet, decoding each length-framed
     * input into the bound instance in order and invoking `onInput` after
     * each decode. `onInput` receives the bound instance itself — reads
     * must be synchronous; downstream code should apply the input to game
     * state, not retain the reference.
     *
     * Returns the number of inputs decoded.
     */
    decodeAll(bytes: Uint8Array, onInput: (instance: T, index: number) => void): number {
        const it = this._it;
        it.offset = 0;
        let count = 0;
        while (it.offset < bytes.length) {
            const len = decode.number(bytes, it);
            const end = it.offset + len;
            this._decoder.decode(bytes.subarray(it.offset, end));
            onInput(this.instance, count);
            it.offset = end;
            count++;
        }
        return count;
    }
}
