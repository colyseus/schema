import * as assert from "assert";
import {
    schema,
    t,
    Schema,
    ArraySchema,
    MapSchema,
    SetSchema,
    CollectionSchema,
    Encoder,
    Decoder,
    StateView,
    Metadata,
    type,
    view,
    SchemaType,
} from "../src";
import { $changes } from "../src/types/symbols";

describe("Zod-style schema() API", () => {
    describe("primitive factories", () => {
        it("creates each primitive with correct type tag", () => {
            const S = schema({
                s: t.string(),
                n: t.number(),
                b: t.boolean(),
                i8: t.int8(),
                u8: t.uint8(),
                i16: t.int16(),
                u16: t.uint16(),
                i32: t.int32(),
                u32: t.uint32(),
                i64: t.int64(),
                u64: t.uint64(),
                f32: t.float32(),
                f64: t.float64(),
                bi64: t.bigint64(),
                bu64: t.biguint64(),
            }, "S");
            const fields = Metadata.getFields(S);
            assert.strictEqual(fields.s, "string");
            assert.strictEqual(fields.n, "number");
            assert.strictEqual(fields.b, "boolean");
            assert.strictEqual(fields.i8, "int8");
            assert.strictEqual(fields.u8, "uint8");
            assert.strictEqual(fields.i16, "int16");
            assert.strictEqual(fields.u16, "uint16");
            assert.strictEqual(fields.i32, "int32");
            assert.strictEqual(fields.u32, "uint32");
            assert.strictEqual(fields.i64, "int64");
            assert.strictEqual(fields.u64, "uint64");
            assert.strictEqual(fields.f32, "float32");
            assert.strictEqual(fields.f64, "float64");
            assert.strictEqual(fields.bi64, "bigint64");
            assert.strictEqual(fields.bu64, "biguint64");
        });

        it(".default() sets the initial value", () => {
            const S = schema({
                hp: t.uint8().default(100),
                name: t.string().default("unknown"),
            }, "S");
            const s = new S();
            assert.strictEqual(s.hp, 100);
            assert.strictEqual(s.name, "unknown");
        });
    });

    describe("collection factories", () => {
        it("t.array(Schema) produces an ArraySchema with auto-default", () => {
            const Item = schema({ qty: t.uint8() }, "Item");
            const Inv = schema({ items: t.array(Item) }, "Inv");

            const inv = new Inv();
            assert.ok(inv.items instanceof ArraySchema);
            assert.strictEqual(inv.items.length, 0);
        });

        it("t.map(Schema) produces a MapSchema with auto-default", () => {
            const Player = schema({ hp: t.uint8() }, "Player");
            const State = schema({ players: t.map(Player) }, "State");

            const s = new State();
            assert.ok(s.players instanceof MapSchema);
            assert.strictEqual(s.players.size, 0);
        });

        it("t.set() and t.collection() produce corresponding types", () => {
            const S = schema({
                tags: t.set("string"),
                bag: t.collection("number"),
            }, "S");
            const s = new S();
            assert.ok(s.tags instanceof SetSchema);
            assert.ok(s.bag instanceof CollectionSchema);
        });

        it("t.array accepts primitive strings", () => {
            const S = schema({ nums: t.array("number") }, "S");
            const s = new S();
            s.nums.push(1, 2, 3);
            assert.deepStrictEqual([...s.nums], [1, 2, 3]);
        });
    });

    describe("chainable modifiers", () => {
        it(".view() without tag uses DEFAULT_VIEW_TAG", () => {
            const S = schema({
                a: t.number(),
                b: t.string().view(),
            }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].tag, undefined);
            assert.strictEqual(meta[1].tag, -1); // DEFAULT_VIEW_TAG
        });

        it(".view(tag) records numeric tag", () => {
            const S = schema({
                a: t.number().view(2),
            }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].tag, 2);
        });

        it(".owned() sets owned flag", () => {
            const S = schema({ hp: t.uint8().owned() }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].owned, true);
        });

        it(".unreliable() sets unreliable flag", () => {
            const S = schema({ ping: t.uint16().unreliable() }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].unreliable, true);
        });

        it(".static() and t.stream() set flags", () => {
            const Entity = schema({ name: t.string() }, "Entity");
            const S = schema({
                level: t.array("number").static(),
                events: t.stream(Entity),
            }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].static, true);
            assert.strictEqual(meta[1].stream, true);
        });

        it(".deprecated() marks field and throws on access by default", () => {
            const S = schema({
                kept: t.number(),
                old: t.string().deprecated(),
            }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[1].deprecated, true);

            const s = new S();
            s.kept = 1;
            assert.throws(() => { (s as any).old; }, /deprecated/);
        });

        it(".deprecated(false) marks field but does not throw", () => {
            const S = schema({
                old: t.string().deprecated(false),
            }, "S");
            const meta = (S as any)[Symbol.metadata];
            assert.strictEqual(meta[0].deprecated, true);

            const s = new S();
            assert.doesNotThrow(() => { (s as any).old; });
        });

        it("modifier chain order does not matter", () => {
            const A = schema({ x: t.number().default(5).view(1).owned() }, "A");
            const B = schema({ x: t.number().owned().view(1).default(5) }, "B");
            const a = new A();
            const b = new B();
            const aMeta = (A as any)[Symbol.metadata];
            const bMeta = (B as any)[Symbol.metadata];

            assert.strictEqual(a.x, 5);
            assert.strictEqual(b.x, 5);
            assert.strictEqual(aMeta[0].tag, 1);
            assert.strictEqual(bMeta[0].tag, 1);
            assert.strictEqual(aMeta[0].owned, true);
            assert.strictEqual(bMeta[0].owned, true);
        });
    });

    describe("inheritance via Parent.extend()", () => {
        const Entity = schema({
            x: t.number(),
            y: t.number(),
        }, "Entity");
        const Player = Entity.extend({
            hp: t.uint8().default(100),
            name: t.string(),
        }, "Player");
        const Warrior = Player.extend({
            weapon: t.string().default("fists"),
        }, "Warrior");

        it("child instances have parent fields", () => {
            const w = new Warrior({ x: 1, y: 2, hp: 50, name: "wulf", weapon: "sword" });
            assert.strictEqual(w.x, 1);
            assert.strictEqual(w.y, 2);
            assert.strictEqual(w.hp, 50);
            assert.strictEqual(w.name, "wulf");
            assert.strictEqual(w.weapon, "sword");
        });

        it("child field indexes continue from parent", () => {
            const meta = (Warrior as any)[Symbol.metadata];
            assert.strictEqual(meta.x, 0);
            assert.strictEqual(meta.y, 1);
            assert.strictEqual(meta.hp, 2);
            assert.strictEqual(meta.name, 3);
            assert.strictEqual(meta.weapon, 4);
        });

        it("class names are preserved", () => {
            assert.strictEqual(Entity.name, "Entity");
            assert.strictEqual(Player.name, "Player");
            assert.strictEqual(Warrior.name, "Warrior");
        });

        it("instanceof works across the chain", () => {
            const w = new Warrior();
            assert.ok(w instanceof Warrior);
            assert.ok(w instanceof Player);
            assert.ok(w instanceof Entity);
            assert.ok(w instanceof Schema);
        });

        it("defaults from each level are applied", () => {
            const w = new Warrior();
            assert.strictEqual(w.hp, 100);
            assert.strictEqual(w.weapon, "fists");
        });
    });

    describe("methods and initialize()", () => {
        it("methods are attached to the prototype", () => {
            const S = schema({
                hp: t.uint8().default(100),
                takeDamage(n: number) { this.hp -= n; },
            }, "S");
            const s = new S();
            (s as any).takeDamage(30);
            assert.strictEqual(s.hp, 70);
        });

        it("initialize() runs on construction of the exact class", () => {
            let calls = 0;
            const S = schema({
                x: t.number(),
                initialize(opts: { x: number }) {
                    calls++;
                    this.x = opts.x * 2;
                },
            }, "S");
            const s = new S({ x: 5 });
            assert.strictEqual(s.x, 10);
            assert.strictEqual(calls, 1);
        });

        it("initialize() does NOT run for parent classes during child construction", () => {
            let parentCalls = 0;
            const Parent = schema({
                x: t.number(),
                initialize() { parentCalls++; },
            }, "Parent");
            const Child = Parent.extend({ y: t.number() }, "Child");

            new Child({ x: 1, y: 2 });
            assert.strictEqual(parentCalls, 0);
        });
    });

    describe("bare Schema class shorthand", () => {
        it("a Schema class used as a field is equivalent to t.ref()", () => {
            class Pos extends Schema {
                @type("number") x = 0;
                @type("number") y = 0;
            }
            const S = schema({ pos: Pos }, "S");
            const s = new S();
            assert.ok(s.pos instanceof Pos);
        });
    });

    describe("encode/decode parity with decorator-based schemas", () => {
        it("builder-based schemas round-trip through the encoder", () => {
            const Item = schema({ qty: t.uint8() }, "Item");
            const Player = schema({
                name: t.string(),
                hp: t.uint8().default(100),
                items: t.array(Item),
            }, "Player");
            const State = schema({
                players: t.map(Player),
            }, "State");

            const encoder = new Encoder(new State());
            const state = encoder.state as InstanceType<typeof State>;

            const alice = new Player({ name: "alice" });
            alice.items.push(new Item({ qty: 3 }));
            state.players.set("a", alice);

            const decoder = new Decoder<InstanceType<typeof State>>(new State());
            const bytes = encoder.encode();
            decoder.decode(bytes);

            const da = decoder.state.players.get("a");
            assert.strictEqual(da!.name, "alice");
            assert.strictEqual(da!.hp, 100);
            assert.strictEqual(da!.items.length, 1);
            assert.strictEqual(da!.items[0].qty, 3);
        });
    });

    describe("validation", () => {
        it("throws when first argument is not a fields object", () => {
            assert.throws(
                () => schema("Name" as any, { x: t.number() } as any),
                /first argument must be a fields object/,
            );
        });

        it("throws when a field value is not a builder/Schema/function", () => {
            assert.throws(
                () => schema({ n: "string" as any }, "Bad"),
                /must be a t\.\* builder/,
            );
        });
    });

    describe("SchemaType<T> helper", () => {
        it("extracts the instance type", () => {
            const S = schema({
                x: t.number(),
                name: t.string(),
            }, "S");
            type SInstance = SchemaType<typeof S>;
            const s: SInstance = new S({ x: 1, name: "hi" });
            assert.strictEqual(s.x, 1);
            assert.strictEqual(s.name, "hi");
        });
    });
});
