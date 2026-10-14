import { Schema, type, MapSchema, TypeContext, Reflection, Encoder } from "../src";
import { InputEncoder } from "../src/input";
import * as assert from "assert";
import * as v8 from "v8";
import * as vm from "vm";
import { entity } from "../src/annotations";

// `gc()` without the --expose-gc CLI flag.
v8.setFlagsFromString("--expose-gc");
const gc: () => void = vm.runInNewContext("gc");

/** Every target collected once nothing but `fn`'s own frame held it. */
async function collected(fn: () => object[]) {
    const refs = fn().map((o) => new WeakRef(o));
    // WeakRef targets are kept until the current job ends.
    await new Promise((resolve) => setImmediate(resolve));
    gc(); gc();
    return refs.every((r) => r.deref() === undefined);
}

describe("TypeContext", () => {
    it("should register all inherited classes", () => {
        class Pokemon extends Schema {
            @type("string") name: string;
        }

        class Unown extends Pokemon {
            @type("number") power: number;
        }

        @entity class UnownA extends Unown {}
        @entity class UnownB extends Unown {}

        class MyState extends Schema {
            @type({ map: Pokemon }) pokemons = new MapSchema<Pokemon>();
        }

        const context = new TypeContext(MyState);

        assert.strictEqual(context.schemas.size, 5);
    })

    describe("classes made by Reflection.decode are released with their decoder", () => {
        class Base extends Schema {
            @type("string") name: string;
        }
        class Child extends Base {
            @type("number") power: number;
        }
        class State extends Schema {
            @type({ map: Base }) things = new MapSchema<Base>();
            @type(Child) child: Child;
        }
        class Input extends Schema {
            @type("number") x: number;
            @type("boolean") jump: boolean;
        }
        const stateBytes = Reflection.encode(new Encoder(new State()));
        const inputBytes = Reflection.encode(new Encoder(new Input()));

        it("an inheritance tree (a client's handshake)", async () => {
            assert.ok(await collected(() => {
                const decoder = Reflection.decode(stateBytes);
                return Object.values(decoder.context.types);
            }));
        });

        it("an input class made encodable (the SDK's room.input())", async () => {
            assert.ok(await collected(() => {
                const Reconstructed = Reflection.decode(inputBytes).state.constructor as any;
                Reflection.makeEncodable(Reconstructed);
                const inst = new Reconstructed();
                inst.x = 1;
                new InputEncoder(inst).encode();
                return [Reconstructed];
            }));
        });

        it("a regular Encoder on a reflected state", async () => {
            assert.ok(await collected(() => {
                const decoder = Reflection.decode(stateBytes);
                const Reconstructed = decoder.state.constructor as any;
                Reflection.makeEncodable(Reconstructed);
                new Encoder(new Reconstructed()).encodeAll();
                return Object.values(decoder.context.types);
            }));
        });
    });

});
