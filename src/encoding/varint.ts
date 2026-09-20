import type { Iterator } from "./decode.js";
import { encode } from "./encode.js";
import { decode } from "./decode.js";

/**
 * Structural primitives of the wire format: LEB128 unsigned varints for every
 * structural integer (refIds, field/entry indexes, counts, lengths, type ids),
 * `uvarint(len) + utf8` strings, LEB128-shaped presence masks and the chunk
 * length back-patch.
 *
 * Every function here is a `function` declaration on purpose: `encode.ts` /
 * `decode.ts` import them for their `string` / `number` slots, and this module
 * imports their utf8 helpers back — hoisted declarations keep the cycle safe.
 */

export function uvarint(bytes: Uint8Array, value: number, it: Iterator): void {
    // 1- and 2-byte cases inline (field headers, refIds, lengths); the loop
    // stays out of line so this fits the inlining budget of the encode loop
    if (value < 0x80) {
        bytes[it.offset++] = value;
        return;
    }
    if (value < 0x4000) {
        bytes[it.offset++] = (value & 0x7f) | 0x80;
        bytes[it.offset++] = value >>> 7;
        return;
    }
    uvarintLong(bytes, value, it);
}

function uvarintLong(bytes: Uint8Array, value: number, it: Iterator): void {
    // >>> keeps the loop on int32 while it can; the division tail covers 2^32..2^53
    while (value >= 0x80) {
        bytes[it.offset++] = (value & 0x7f) | 0x80;
        value = (value <= 0xFFFFFFFF) ? (value >>> 7) : Math.floor(value / 128);
    }
    bytes[it.offset++] = value;
}

export function uvarintSize(value: number): number {
    let size = 1;
    while (value >= 0x80) {
        size++;
        value = (value <= 0xFFFFFFFF) ? (value >>> 7) : Math.floor(value / 128);
    }
    return size;
}

export function readUvarint(bytes: Uint8Array, it: Iterator): number {
    let b = bytes[it.offset++];
    let result = b & 0x7f;
    if (b < 0x80) return result;
    b = bytes[it.offset++];
    result |= (b & 0x7f) << 7;
    if (b < 0x80) return result;
    b = bytes[it.offset++];
    result |= (b & 0x7f) << 14;
    if (b < 0x80) return result;
    b = bytes[it.offset++];
    result |= (b & 0x7f) << 21;
    if (b < 0x80) return result;
    // 5th byte and beyond: multiply — shifting past bit 31 would overflow int32
    let scale = 0x10000000;
    for (;;) {
        b = bytes[it.offset++];
        result += (b & 0x7f) * scale;
        if (b < 0x80 || it.offset > bytes.length) return result;
        scale *= 128;
    }
}

/**
 * Presence mask over up to 64 field indexes, as 7-bit groups (LEB128 shape):
 * bit `i` of the mask lives in group `i / 7`, bit `i % 7`. Only groups up to
 * the highest set bit are written, so a sparse instance of a wide schema
 * costs one byte.
 */
export function writeMask64(bytes: Uint8Array, low: number, high: number, it: Iterator): void {
    // low = bits 0..31, high = bits 32..63 (both as uint32)
    for (;;) {
        const group = low & 0x7f;
        low = (low >>> 7) | ((high & 0x7f) << 25);
        high = high >>> 7;
        if ((low | high) === 0) {
            bytes[it.offset++] = group;
            return;
        }
        bytes[it.offset++] = group | 0x80;
    }
}

const _lenIt: Iterator = { offset: 0 };

/**
 * Strings of at least this many UTF-16 units are encoded by
 * `TextEncoder.encodeInto` (one native call, ~80 ns flat) instead of the
 * char loop (~3 ns per char); measured crossover for ASCII, accented and CJK
 * text alike (bench/realworld-results.md, "Round 2 — D").
 */
const ENCODE_INTO_MIN = 32;

/**
 * `uvarint(utf8ByteLength) utf8Bytes`. `null` / `undefined` ride as `""`.
 *
 * Single pass: the UTF-8 is written behind one reserved length byte and the
 * length is back-patched; only a body of 128+ bytes has to move up by the
 * extra prefix bytes (the same scheme as `endChunk`). A write past the buffer
 * end leaves `it.offset` beyond `bytes.byteLength` so the caller's overflow
 * check triggers a resize + re-encode, exactly as the char loop always did.
 */
export function writeString(bytes: Uint8Array, value: string | null | undefined, it: Iterator): void {
    if (!value) { bytes[it.offset++] = 0; return; }
    const lenPos = it.offset++;
    if (value.length < ENCODE_INTO_MIN || encode.textEncoder === undefined) {
        encode.utf8Write(bytes, value, it);
    } else {
        encode.utf8EncodeInto(bytes, value, it);
    }
    const len = it.offset - lenPos - 1;
    if (len < 0x80) {
        bytes[lenPos] = len;
        return;
    }
    const n = uvarintSize(len);
    const extra = n - 1;
    if (it.offset + extra > bytes.byteLength) {
        it.offset += extra; // overflow: the caller resizes and re-encodes
        return;
    }
    bytes.copyWithin(lenPos + n, lenPos + 1, it.offset);
    _lenIt.offset = lenPos;
    uvarint(bytes, len, _lenIt);
    it.offset += extra;
}

export function readString(bytes: Uint8Array, it: Iterator): string {
    const length = readUvarint(bytes, it);
    return decode.utf8Read(bytes, it, length); // clamps to the buffer
}

const _conv = new ArrayBuffer(8);
const _i32 = new Int32Array(_conv);
const _f32 = new Float32Array(_conv);
const _f64 = new Float64Array(_conv);

/**
 * Dynamic `number` (msgpack-shaped): positive fixint `0x00–0x7f`, negative
 * fixint `0xe0–0xff`, `0xcc/0xcd/0xce` uint8/16/32, `0xd0–0xd2` int8/16/32,
 * `0xca` float32 (chosen when `|f32(v) − v| < 1e-4`), `0xcb` float64. Integers
 * beyond 32 bits and non-finite values take the float64 form. Reads back
 * through `decode.number`.
 */
export function writeNumber(bytes: Uint8Array, value: number, it: Iterator): void {
    if (value === (value | 0)) {
        if (value >= 0) {
            if (value < 0x80) { bytes[it.offset++] = value & 255; return; }
            if (value < 0x100) { bytes[it.offset++] = 0xcc; bytes[it.offset++] = value & 255; return; }
            if (value < 0x10000) { bytes[it.offset++] = 0xcd; bytes[it.offset++] = value & 255; bytes[it.offset++] = (value >> 8) & 255; return; }
            bytes[it.offset++] = 0xce;
        } else {
            if (value >= -0x20) { bytes[it.offset++] = 0xe0 | (value + 0x20); return; }
            if (value >= -0x80) { bytes[it.offset++] = 0xd0; bytes[it.offset++] = value & 255; return; }
            if (value >= -0x8000) { bytes[it.offset++] = 0xd1; bytes[it.offset++] = value & 255; bytes[it.offset++] = (value >> 8) & 255; return; }
            bytes[it.offset++] = 0xd2;
        }
        bytes[it.offset++] = value & 255;
        bytes[it.offset++] = (value >> 8) & 255;
        bytes[it.offset++] = (value >> 16) & 255;
        bytes[it.offset++] = (value >> 24) & 255;
        return;
    }
    if (value !== value) { value = 0; } // NaN rides as 0 (legacy behaviour)
    else if (value === Infinity) { value = Number.MAX_SAFE_INTEGER; }
    else if (value === -Infinity) { value = -Number.MAX_SAFE_INTEGER; }
    else if (Math.abs(value) <= 3.4028235e+38) {
        _f32[0] = value;
        if (Math.abs(Math.abs(_f32[0]) - Math.abs(value)) < 1e-4) {
            const bits = _i32[0];
            bytes[it.offset++] = 0xca;
            bytes[it.offset++] = bits & 255;
            bytes[it.offset++] = (bits >> 8) & 255;
            bytes[it.offset++] = (bits >> 16) & 255;
            bytes[it.offset++] = (bits >> 24) & 255;
            return;
        }
    }
    _f64[0] = value;
    bytes[it.offset++] = 0xcb;
    let bits = _i32[0]; // little-endian words
    bytes[it.offset++] = bits & 255;
    bytes[it.offset++] = (bits >> 8) & 255;
    bytes[it.offset++] = (bits >> 16) & 255;
    bytes[it.offset++] = (bits >> 24) & 255;
    bits = _i32[1];
    bytes[it.offset++] = bits & 255;
    bytes[it.offset++] = (bits >> 8) & 255;
    bytes[it.offset++] = (bits >> 16) & 255;
    bytes[it.offset++] = (bits >> 24) & 255;
}

/**
 * Close a chunk (opened as `uvarint(refId)` + one reserved byte) by
 * back-patching its length. Lengths ≥ 128 need more than the reserved byte:
 * the chunk body is moved up by `n - 1` bytes first — unless that would
 * overrun `capacity`, in which case only the offset is advanced so the
 * caller's overflow check triggers a resize + re-encode (a clamped
 * `copyWithin` would silently corrupt the tail).
 */
export function endChunk(bytes: Uint8Array, lenPos: number, it: Iterator, capacity: number, flag: number = 0): void {
    const len = it.offset - lenPos - 1;
    const v = len * 2 + flag; // low bit: 0 = chunk, 1 = same-shape run
    if (v < 0x80) {
        bytes[lenPos] = v;
        return;
    }
    const n = uvarintSize(v);
    const extra = n - 1;
    if (it.offset + extra > capacity) {
        it.offset += extra;
        return;
    }
    bytes.copyWithin(lenPos + n, lenPos + 1, it.offset);
    _lenIt.offset = lenPos;
    uvarint(bytes, v, _lenIt);
    it.offset += extra;
}
