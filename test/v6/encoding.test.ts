import * as assert from "assert";
import {
    uvarint, uvarintSize, readUvarint, writeMask64, string6, readString6, endChunk,
} from "../../src/v6/encoding";

/** A chunk opens as `uvarint(refId)` + one reserved length byte (inline in the encoder). */
function beginChunk(bytes: Uint8Array, refId: number, it: { offset: number }): number {
    uvarint(bytes, refId, it);
    return it.offset++;
}

function roundtripUvarint(value: number) {
    const bytes = new Uint8Array(16);
    const it = { offset: 0 };
    uvarint(bytes, value, it);
    assert.strictEqual(it.offset, uvarintSize(value), `size of ${value}`);
    const rit = { offset: 0 };
    assert.strictEqual(readUvarint(bytes, rit), value, `value ${value}`);
    assert.strictEqual(rit.offset, it.offset, `read offset of ${value}`);
    return it.offset;
}

describe("v6 encoding", () => {
    it("uvarint boundaries", () => {
        assert.strictEqual(roundtripUvarint(0), 1);
        assert.strictEqual(roundtripUvarint(127), 1);
        assert.strictEqual(roundtripUvarint(128), 2);
        assert.strictEqual(roundtripUvarint(16383), 2);
        assert.strictEqual(roundtripUvarint(16384), 3);
        assert.strictEqual(roundtripUvarint(2 ** 21 - 1), 3);
        assert.strictEqual(roundtripUvarint(2 ** 21), 4);
        assert.strictEqual(roundtripUvarint(2 ** 28 - 1), 4);
        assert.strictEqual(roundtripUvarint(2 ** 28), 5);
        assert.strictEqual(roundtripUvarint(2 ** 31 - 1), 5);
        assert.strictEqual(roundtripUvarint(2 ** 32 - 1), 5);
        assert.strictEqual(roundtripUvarint(2 ** 32), 5);
        assert.strictEqual(roundtripUvarint(2 ** 35), 6);
        assert.strictEqual(roundtripUvarint(Number.MAX_SAFE_INTEGER), 8);
    });

    it("presence mask groups 7 bits per byte up to the highest set bit", () => {
        const bytes = new Uint8Array(16);
        let it = { offset: 0 };
        writeMask64(bytes, 0, 0, it);
        assert.deepStrictEqual(Array.from(bytes.subarray(0, it.offset)), [0x00]);

        it = { offset: 0 };
        writeMask64(bytes, 0b0000101, 0, it);
        assert.deepStrictEqual(Array.from(bytes.subarray(0, it.offset)), [0b0000101]);

        it = { offset: 0 };
        writeMask64(bytes, 1 << 7, 0, it); // field 7 → second group, bit 0
        assert.deepStrictEqual(Array.from(bytes.subarray(0, it.offset)), [0x80, 0x01]);

        it = { offset: 0 };
        writeMask64(bytes, 0xFFFFFFFF, 0, it); // fields 0..31 → 5 groups (32 = 4×7 + 4)
        assert.deepStrictEqual(Array.from(bytes.subarray(0, it.offset)), [0xff, 0xff, 0xff, 0xff, 0x0f]);

        it = { offset: 0 };
        writeMask64(bytes, 0, 1 << 3, it); // field 35 → group 5, bit 0
        assert.deepStrictEqual(Array.from(bytes.subarray(0, it.offset)), [0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);

        it = { offset: 0 };
        writeMask64(bytes, 0, 1 << 31, it); // field 63 → group 9, bit 0
        assert.strictEqual(it.offset, 10);
        assert.strictEqual(bytes[9], 0x01);
    });

    it("strings use a LEB128 length prefix", () => {
        const bytes = new Uint8Array(1024);
        for (const s of ["", "a", "x".repeat(31), "x".repeat(32), "x".repeat(127), "x".repeat(128), "ção 🎉", "x".repeat(300)]) {
            const it = { offset: 0 };
            string6(bytes, s, it);
            const utf8 = Buffer.byteLength(s);
            assert.strictEqual(it.offset, uvarintSize(utf8) + utf8, `size of ${JSON.stringify(s.slice(0, 8))}`);
            const rit = { offset: 0 };
            assert.strictEqual(readString6(bytes, rit), s);
            assert.strictEqual(rit.offset, it.offset);
        }
        const it = { offset: 0 };
        string6(bytes, null, it);
        assert.deepStrictEqual(Array.from(bytes.subarray(0, 1)), [0]);
    });

    it("chunk length back-patch moves the body when the length needs more bytes", () => {
        const bytes = new Uint8Array(4096);
        const it = { offset: 0 };
        const lenPos = beginChunk(bytes, 300, it); // 2-byte refId
        assert.strictEqual(lenPos, 2);
        for (let i = 0; i < 200; i++) bytes[it.offset++] = i & 0xff;
        endChunk(bytes, lenPos, it, bytes.length);
        const rit = { offset: 0 };
        assert.strictEqual(readUvarint(bytes, rit), 300);
        assert.strictEqual(readUvarint(bytes, rit), 200);
        assert.strictEqual(rit.offset, 4);
        for (let i = 0; i < 200; i++) assert.strictEqual(bytes[rit.offset + i], i & 0xff);
        assert.strictEqual(it.offset, 4 + 200);

        // short chunk: single byte, no move
        const it2 = { offset: 0 };
        const lp2 = beginChunk(bytes, 5, it2);
        bytes[it2.offset++] = 42;
        endChunk(bytes, lp2, it2, bytes.length);
        assert.deepStrictEqual(Array.from(bytes.subarray(0, 3)), [5, 1, 42]);
    });

    it("chunk back-patch refuses to move past capacity and only advances the offset", () => {
        const bytes = new Uint8Array(210);
        const it = { offset: 0 };
        const lenPos = beginChunk(bytes, 1, it);
        for (let i = 0; i < 208; i++) bytes[it.offset++] = 7;
        assert.strictEqual(it.offset, 210);
        endChunk(bytes, lenPos, it, bytes.length);
        assert.strictEqual(it.offset, 211); // > capacity → caller re-encodes
    });
});
