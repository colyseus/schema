import * as assert from "assert";

import { INDEX_CHANGE, NIL } from "../src/spec";
import * as encode from "../src/encoding/encode";
import { nilCheck, numberCheck, indexChangeCheck } from "../src/encoding/decode";

describe("Spec / Protocol", () => {
    describe("spec", () => {
        it("INDEX_CHANGE shouldn't collide", () => {
            const bytes = [INDEX_CHANGE];
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), true);
            assert.equal(numberCheck(bytes, { offset: 0 }), false);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
        });

        it("NIL shouldn't collide", () => {
            const bytes = [NIL];
            assert.equal(nilCheck(bytes, { offset: 0 }), true);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
            assert.equal(numberCheck(bytes, { offset: 0 }), false);
        });
    });

    describe("primitive numbers", () => {
        it("uint8 shouldn't collide", () => {
            const bytes = [];
            encode.uint8(bytes, 254);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint16 shouldn't collide", () => {
            const bytes = [];
            encode.uint16(bytes, 65534);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint32 shouldn't collide", () => {
            const bytes = [];
            encode.uint32(bytes, 4294967294);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint64 shouldn't collide", () => {
            const bytes = [];
            encode.uint64(bytes, 18446744073709552000);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("int8 shouldn't collide", () => {
            const bytes = [];
            encode.int8(bytes, 126);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int16 shouldn't collide", () => {
            const bytes = [];
            encode.int16(bytes, 32767);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int32 shouldn't collide", () => {
            const bytes = [];
            encode.int32(bytes, 2147483646);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int64 shouldn't collide", () => {
            const bytes = [];
            encode.int64(bytes, 9223372036854776000);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });
    });

    describe("dynamic numbers", () => {
        it("string should't collide with number", () => {
            for (let i = 0; i <= 1024; i++) {
                const bytes = [];
                encode.string(bytes, i.toString());
                assert.equal(numberCheck(bytes, { offset: 0 }), false);
                assert.equal(nilCheck(bytes, { offset: 0 }), false);
                assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
            }
        });

        it("uint8 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 254);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint16 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 65534);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint32 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 4294967294);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("uint64 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 18446744073709552000);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        })

        it("int8 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 126);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int16 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 32767);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int32 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 2147483646);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });

        it("int64 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 9223372036854776000);
            assert.equal(numberCheck(bytes, { offset: 0 }), true);
            assert.equal(nilCheck(bytes, { offset: 0 }), false);
            assert.equal(indexChangeCheck(bytes, { offset: 0 }), false);
        });
    });
})