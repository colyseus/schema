import * as assert from "assert";
import { decode } from "../src/encoding/decode";
import { encode } from "../src/encoding/encode";

describe("Decoder", () => {
    it("should handle string with length way higher than actual provided bytes", () => {
        // `uvarint(len) + utf8`: a declared length far past the buffer end
        // (malicious or corrupted input) must clamp to the bytes available
        // instead of allocating or reading past the buffer.
        const buffer = new Uint8Array(16);
        const it = { offset: 0 };
        encode.number(buffer, 1212328763, it); // any bytes after the length: "abc" + junk
        const start = { offset: 0 };
        buffer.set([0xbb, 0xa3, 0xea, 0xc1, 0x04], 0); // uvarint(1_212_328_763)
        buffer.set([97, 98, 99], 5);

        let str: string;
        assert.doesNotThrow(() => str = decode.string(buffer, start));

        assert.strictEqual(str.slice(0, 3), "abc");
        assert.strictEqual(start.offset, buffer.length, "iterator offset should clamp to the buffer end");
    });

    it("round-trips strings through the uvarint-length form", () => {
        const buffer = new Uint8Array(64);
        const it = { offset: 0 };
        encode.string(buffer, "héllo wörld", it);
        const rit = { offset: 0 };
        assert.strictEqual(decode.string(buffer, rit), "héllo wörld");
        assert.strictEqual(rit.offset, it.offset);
    });
});
