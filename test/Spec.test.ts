import * as assert from "assert";

import * as encode from "../src/encoding/encode";
import { numberCheck, switchStructureCheck } from "../src/encoding/decode";

describe("Spec / Protocol", () => {
    describe("dynamic numbers", () => {
        it("string should't collide with number", () => {
            for (let i = 0; i <= 1024; i++) {
                const bytes = Buffer.alloc(32)
                encode.string(bytes, i.toString(), { offset: 0 });
                assert.strictEqual(numberCheck(bytes, { offset: 0 }), false, `string "${i}" misunderstood as number`);
                assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `string "${i}" misunderstood as switch structure`);
            }
        });

        it("uint8 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 254, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint16 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 65534, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint32 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 4294967294, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("uint64 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 18446744073709552000, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        })

        it("int8 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 126, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int16 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 32767, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int32 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 2147483646, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });

        it("int64 shouldn't collide", () => {
            const bytes = Buffer.alloc(32)
            encode.number(bytes, 9223372036854776000, { offset: 0 });
            assert.strictEqual(numberCheck(bytes, { offset: 0 }), true);
            assert.strictEqual(switchStructureCheck(bytes, { offset: 0 }), false, `misunderstood as switch structure`);
        });
    });
})