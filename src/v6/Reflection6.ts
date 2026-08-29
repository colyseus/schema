import type { Schema } from "../Schema.js";
import type { Iterator } from "../encoding/decode.js";
import { Reflection, materializeReflection, populateReflection } from "../Reflection.js";
import { Decoder6 } from "./Decoder6.js";
import { Encoder6 } from "./Encoder6.js";
import { readUvarint } from "./encoding.js";
import { PROTOCOL_VERSION } from "./spec.js";

/**
 * v6 handshake: `uvarint(6)` followed by the `Reflection` schema encoded with
 * the v6 codec itself (nested Schema + array + optional field — a free
 * self-hosting fixture).
 */
export const Reflection6 = {
    encode(encoder: Encoder6, _it?: Iterator): Uint8Array {
        const reflection = new Reflection();
        const reflectionEncoder = new Encoder6(reflection);
        populateReflection(reflection, encoder.context, encoder.state.constructor as typeof Schema);
        const encoded = reflectionEncoder.encodeAll();
        const out = new Uint8Array(1 + encoded.byteLength);
        out[0] = PROTOCOL_VERSION;
        out.set(encoded, 1);
        return out;
    },

    decode<T extends Schema = Schema>(bytes: Uint8Array, it: Iterator = { offset: 0 }): Decoder6<T> {
        const version = readUvarint(bytes, it);
        if (version !== PROTOCOL_VERSION) {
            throw new Error(`@colyseus/schema v6: expected protocol version ${PROTOCOL_VERSION}, got ${version}`);
        }
        const reflection = new Reflection();
        new Decoder6(reflection).decode(bytes, it);
        const { typeContext, state } = materializeReflection<T>(reflection);
        return new Decoder6<T>(state, typeContext);
    },
};

Reflection.codecs[PROTOCOL_VERSION] = Reflection6;
