import { encode } from "../encoding/encode.js";
import { decode, type Iterator } from "../encoding/decode.js";

/**
 * v6 primitives: LEB128 unsigned varints for every structural integer,
 * `uvarint(len) + utf8` strings, LEB128-style presence masks. Fixed-width
 * numbers and the `number` dynamic encoding are inherited from v5 unchanged.
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

export function string6(bytes: Uint8Array, value: string | null | undefined, it: Iterator): void {
    if (!value) { value = ""; } // null strings ride as empty, like v5
    const length = encode.utf8Length(value, "utf8");
    uvarint(bytes, length, it);
    encode.utf8Write(bytes, value, it);
}

export function readString6(bytes: Uint8Array, it: Iterator): string {
    const length = readUvarint(bytes, it);
    return decode.utf8Read(bytes, it, length); // clamps to the buffer
}

const _conv = new ArrayBuffer(8);
const _i32 = new Int32Array(_conv);
const _f32 = new Float32Array(_conv);
const _f64 = new Float64Array(_conv);

/**
 * Dynamic `number` (msgpack), byte-identical to v5 `encode.number` (same
 * float32-when-close-enough heuristic, same integer prefixes); fuzzed against
 * it. Kept separate so the hot path pays one float32 conversion and no
 * `isNaN` / `isFinite` calls.
 */
export function number6(bytes: Uint8Array, value: number, it: Iterator): void {
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
    if (value !== value || value === Infinity || value === -Infinity) { encode.number(bytes, value, it); return; }
    if (Math.abs(value) <= 3.4028235e+38) {
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
    let bits = _i32[0]; // little-endian words, as v5
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

/** Per-type writer table: v5 writers with `string` (LEB128 length) and `number` (leaner, same bytes) swapped. */
export const encode6: { [type: string]: (bytes: Uint8Array, value: any, it: Iterator) => void } = {
    ...(encode as any),
    string: string6,
    number: number6,
};

/** Per-type reader table: v5 readers with `string` swapped. */
export const decode6: { [type: string]: (bytes: Uint8Array, it: Iterator) => any } = {
    ...(decode as any),
    string: readString6,
};

const _lenIt: Iterator = { offset: 0 };

/**
 * Close a chunk (opened as `uvarint(refId)` + one reserved byte) by
 * back-patching its length. Lengths ≥ 128 need more than
 * the reserved byte: the chunk body is moved up by `n - 1` bytes first —
 * unless that would overrun `capacity`, in which case only the offset is
 * advanced so the caller's overflow check triggers a resize + re-encode
 * (a clamped `copyWithin` would silently corrupt the tail).
 */
export function endChunk(bytes: Uint8Array, lenPos: number, it: Iterator, capacity: number): void {
    const len = it.offset - lenPos - 1;
    if (len < 0x80) {
        bytes[lenPos] = len;
        return;
    }
    const n = uvarintSize(len);
    const extra = n - 1;
    if (it.offset + extra > capacity) {
        it.offset += extra;
        return;
    }
    bytes.copyWithin(lenPos + n, lenPos + 1, it.offset);
    _lenIt.offset = lenPos;
    uvarint(bytes, len, _lenIt);
    it.offset += extra;
}
