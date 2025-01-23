import * as assert from "assert";
import { Schema, type, encode, decode, defineCustomTypes } from "../src";
import { TextDecoder, TextEncoder } from "util";

describe("CustomPrimitiveTypes", () => {

    const _encoder = new TextEncoder();
    const _decoder = new TextDecoder();

    const _convoBuffer = new ArrayBuffer(8);
    const _uint16 = new Uint16Array(_convoBuffer);
    const _uint32 = new Uint32Array(_convoBuffer);
    const _uint64 = new BigUint64Array(_convoBuffer);
    const _int32 = new Int32Array(_convoBuffer);
    const _int64 = new BigInt64Array(_convoBuffer);
    const _float32 = new Float32Array(_convoBuffer);
    const _float64 = new Float64Array(_convoBuffer);

    const types = {
        cstring: {
            encode: (bytes, value, it) => {
                value ??= "";
                value += "\x00";
                if (bytes instanceof Uint8Array) {
                    it.offset += _encoder.encodeInto(value, bytes.subarray(it.offset)).written;
                } else {
                    const encoded = _encoder.encode(value);
                    const len = encoded.length;
                    for (let i = 0; i < len; ++i) bytes[it.offset++] = encoded[i]; // could probably also figure out if bytes has .set
                }
            },
            decode: (bytes, it) => {
                // should short circuit if buffer length can't be determined for some reason so we don't just infinitely loop
                const len = (bytes as Buffer | ArrayBuffer).byteLength ?? (bytes as number[]).length;
                if (len === undefined) throw TypeError("Unable to determine length of 'BufferLike' " + bytes.toString());
                let start = it.offset;
                while (it.offset < len && bytes[it.offset++] !== 0x00) { }; // nop, fast search for terminator
                return _decoder.decode(new Uint8Array((bytes as Buffer | Uint8Array)?.subarray?.(start, it.offset - 1) ?? bytes.slice(start, it.offset - 1))); // ignore terminator
            }
        },

        bigInt64: {
            encode(bytes, value, it) {
                _int64[0] = BigInt.asIntN(64, value);
                encode.int32(bytes, _int32[0], it);
                encode.int32(bytes, _int32[1], it);
            },
            decode(bytes, it) {
                _int32[0] = decode.int32(bytes, it);
                _int32[1] = decode.int32(bytes, it);
                return _int64[0];
            },
        },

        bigUint64: {
            encode (bytes, value, it) {
                _int64[0] = BigInt.asIntN(64, value);
                encode.int32(bytes, _int32[0], it);
                encode.int32(bytes, _int32[1], it);
            },
            decode(bytes, it) {
                _int32[0] = decode.int32(bytes, it);
                _int32[1] = decode.int32(bytes, it);
                return _uint64[0];
            }
        },

        varUint: {
            encode(bytes, value, it) {
                value |= 0; // Infinity, -Infinity, NaN = 0
                do {
                    let byte = value;
                    value >>>= 7; // shift by 7 bits
                    if (value) byte |= 0x80; // set continuation indicator bit
                    bytes[it.offset++] = byte & 0xFF; // set byte
                } while (value !== 0);
            },
            decode(bytes, it) {
                let value = 0, shift = 0;
                while(bytes[it.offset] & 0x80) { // check continuation indicator bit
                  value |= (bytes[it.offset++] & 0x7f) << shift; // read 7 bits
                  shift += 7; // next 7 bits
                }
                value |= (bytes[it.offset++] & 0x7f) << shift; // read remaining bits
                return value;
            }
        },

        varInt: {
            encode(bytes, value, it) {
                types.varUint.encode(bytes, (0 - (value < 0 ? 1 : 0)) ^ (value << 1), it); // zig zag encoding
            },
            decode (bytes, it) {
                const value = types.varUint.decode(bytes, it);
                return (0 - (value & 1)) ^ (value >>> 1); // zig zag decoding
            }
        },

        varBigUint: {
            encode (bytes, value, it) {
                do {
                    let byte = value;
                    value >>= 7n; // shift by 7 bits
                    if (value) byte |= 0x80n; // set continuation indicator bit
                    bytes[it.offset++] = Number(byte & 0xFFn); // set byte
                } while (value !== 0n);
            },
            decode (bytes, it) {
                let value = 0n, shift = 0n;
                while(bytes[it.offset] & 0x80) { // check continuation indicator bit
                  value |= BigInt((bytes[it.offset++] & 0x7f)) << shift; // read 7 bits
                  shift += 7n; // next 7 bits
                }
                value |= BigInt((bytes[it.offset++] & 0x7f)) << shift; // read remaining bits
                return value;
            }
        },

        varBigInt: {
            encode (bytes, value, it) {
                types.varBigUint.encode(bytes, (0n - (value < 0n ? 1n : 0n)) ^ (value << 1n), it); // zig zag encoding
            },
            decode (bytes, it) {
                const value = types.varBigUint.decode(bytes, it);
                return (0n - (value & 1n)) ^ (value >> 1n); // zig zag decoding
            }
        },

        varFloat32: {
            encode (bytes, value, it) {
                _float32[0] = value;
                // there are scenarios where splitting is unoptimal, however splitting usually is a bit more efficient
                types.varUint.encode(bytes, _uint16[0], it); // mantissa (16 bits)
                types.varUint.encode(bytes, _uint16[1], it); // mantissa (7 bits), exponent (8 bits), sign (1 bit)
            },
            decode (bytes, it) {
                _uint16[0] = types.varUint.decode(bytes, it);
                _uint16[1] = types.varUint.decode(bytes, it);
                return _float32[0];
            }
        },

        varFloat64: {
            encode (bytes, value, it) {
                _float64[0] = value;

                // there are scenarios where splitting is unoptimal, however splitting usually is a bit more efficient
                types.varUint.encode(bytes, _uint32[0], it); // mantissa (32 bits)
                types.varUint.encode(bytes, _uint32[1], it); // mantissa (20 bits), exponent (11 bits), sign (1 bit)
            },
            decode (bytes, it) {
                _uint32[0] = types.varUint.decode(bytes, it);
                _uint32[1] = types.varUint.decode(bytes, it);
                return _float64[0];
            }
        },
    };

    const customType = defineCustomTypes(types)

    it("cstring", () => {
        class State extends Schema {
            @customType("cstring") cstr: string;
            @type("string") str: string;
        }

        const state = new State();
        state.cstr = "Hello world!";
        state.str = "Hello world!";

        const decodedState = new State();
        decodedState.decode(state.encode());

        assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
    })

    it("cstring", () => {
        class Data extends Schema {
            @customType("cstring") string: string;
        }

        let data = new Data();
        data.string = "test12345";

        let encoded = data.encode();

        const decoded = new Data();
        decoded.decode(encoded);
        assert.strictEqual(decoded.string, "test12345");
    });

    it("bigints", () => {
        class Data extends Schema {
            @customType("bigUint64") u64: bigint;
            @customType("bigInt64") i64: bigint;
        }

        const buint = BigInt(Number.MAX_SAFE_INTEGER) + 10000n;
        const bint = BigInt(Number.MIN_SAFE_INTEGER) - 10000n;

        let data = new Data();
        data.u64 = buint;
        data.i64 = bint;

        let encoded = data.encode();

        const decoded = new Data();
        decoded.decode(encoded);

        assert.strictEqual(decoded.u64, buint);
        assert.strictEqual(decoded.i64, bint);
    });

    it("leb128", () => {
        class Data extends Schema {
            @customType("varUint") vu: number;
            @customType("varInt") vi: number;
            @customType("varBigUint") vbu: bigint;
            @customType("varBigInt") vbi: bigint;
            @customType("varFloat32") vf32: number;
            @customType("varFloat64") vf64: number;
        }

        let data = new Data();
        data.vu = 2 ** 30;
        data.vi = -(2 ** 30);
        data.vbu = 0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFFn; // 128 bit
        data.vbi = -0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFFn;
        data.vf32 = -5.3235;
        data.vf64 = 1.7976931348623157e+308;

        let encoded = data.encode();

        const decoded = new Data();
        decoded.decode(encoded);

        assert.strictEqual(decoded.vu, 2 ** 30);
        assert.strictEqual(decoded.vi, -(2 ** 30));
        assert.strictEqual(decoded.vbu, 0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFFn);
        assert.strictEqual(decoded.vbi, -0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFFn);
        assert.strictEqual(decoded.vf32.toPrecision(5), "-5.3235");
        assert.strictEqual(decoded.vf64, 1.7976931348623157e+308);
    });

});
