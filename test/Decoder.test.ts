import * as assert from "assert";
import { decode } from "../src/encoding/decode";

describe("Decoder", () => {
    it("should handle string with length way higher than actual provided bytes", () => {
        // Buffer with prefix 0xdb (219) indicating str32 format
        // Next 4 bytes (59, 171, 66, 72) decode to string length: 1,212,328,763
        // But the actual buffer is only 256 bytes
        const buffer = [
            219, 59, 171, 66, 72, 65, 58, 222, 247, 182, 250, 94, 163, 168, 62, 64,
            134, 169, 128, 52, 237, 237, 78, 3, 92, 0, 240, 209, 213, 115, 79, 120,
            11, 12, 243, 204, 100, 159, 106, 13, 164, 29, 192, 154, 57, 231, 78, 14,
            2, 30, 99, 107, 92, 39, 5, 74, 2, 120, 10, 11, 96, 123, 49, 134,
            154, 222, 216, 63, 242, 125, 85, 235, 108, 56, 251, 235, 190, 63, 250, 21,
            240, 17, 247, 175, 180, 215, 27, 229, 116, 92, 82, 70, 84, 252, 193, 104,
            138, 140, 90, 86, 30, 79, 91, 77, 88, 181, 206, 224, 48, 223, 84, 37,
            215, 91, 109, 107, 238, 33, 116, 79, 151, 202, 14, 65, 126, 179, 172, 19,
            162, 120, 59, 34, 115, 46, 0, 67, 199, 224, 216, 125, 247, 59, 245, 89,
            153, 61, 146, 19, 165, 202, 212, 221, 56, 199, 134, 186, 181, 234, 192, 103,
            99, 92, 49, 66, 63, 4, 135, 97, 171, 71, 82, 249, 176, 75, 159, 198,
            253, 126, 119, 112, 138, 147, 18, 222, 98, 90, 112, 67, 35, 128, 136, 102,
            232, 75, 226, 41, 78, 117, 179, 200, 234, 224, 220, 64, 220, 110, 245, 19,
            16, 243, 245, 133, 141, 98, 209, 86, 65, 110, 217, 141, 221, 174, 19, 206,
            58, 11, 63, 18, 175, 68, 39, 218, 80, 226, 242, 2, 180, 36, 75, 40,
            204, 25, 195, 150, 42, 196, 63, 22, 62, 118, 43, 54, 106, 205, 194, 4
        ];

        const it = { offset: 0 };

        // Verify stringCheck identifies this as a string prefix
        assert.strictEqual(decode.stringCheck(buffer, it), true, "stringCheck should return true for 0xdb prefix");

        // Verify the prefix is 0xdb (219) - str32 format
        assert.strictEqual(buffer[0], 0xdb, "First byte should be 0xdb (219)");

        // Read the declared string length (will be 1,212,328,763)
        const prefixOffset = { offset: it.offset + 1 };
        const declaredLength = decode.uint32(buffer, prefixOffset);
        assert.strictEqual(declaredLength, 1212328763, "Declared string length should be 1,212,328,763");
        assert.strictEqual(buffer.length, 256, "Actual buffer size should be 256 bytes");

        // This edge case shows that malicious or corrupted data could cause:
        // - Memory exhaustion (trying to allocate 1.2GB+ for string concatenation)
        // - Potential DoS attack vector
        // - Reading beyond buffer boundaries
        let str: string;
        assert.doesNotThrow(() => str = decode.string(buffer, it));

        assert.strictEqual(str.length, 3, "String length should be 3 bytes");
        assert.strictEqual(it.offset, 256, "Iterator offset should be 256");
    });
});

