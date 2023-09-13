import * as assert from "assert";

import * as encode from "../src/encoding/encode";
import { numberCheck, switchStructureCheck } from "../src/encoding/decode";

describe("Spec / Protocol", () => {
    describe("dynamic numbers", () => {
        it("string should't collide with number", () => {
            for (let i = 0; i <= 1024; i++) {
                const bytes = [];
                encode.string(bytes, i.toString());
                assert.strictEqual(numberCheck(bytes, { offset: 0 }), false, `string "${i}" misunderstood as number`);
                assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `string "${i}" misunderstood as switch structure`);
            }
        });

        it("uint8 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 254);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint16 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 65534);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint32 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 4294967294);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint64 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 18446744073709552000);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("int8 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 126);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int16 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 32767);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int32 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 2147483646);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int64 shouldn't collide", () => {
            const bytes = [];
            encode.number(bytes, 9223372036854776000);
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });
    });
})