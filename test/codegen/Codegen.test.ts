import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as rimraf from "rimraf";
import * as glob from "glob";
import * as assert from "assert";
import { generate } from "../../src/codegen/api.js";
import { parseFiles } from "../../src/codegen/parser.js";
import { Context, Class, getInheritanceTree } from "../../src/codegen/types.js";
import { $numFields } from "../../src/types/symbols.js";
import { NoSyncParent, NoSyncChild, FunctionMembers } from "./sources/NoSync.js";
import { Look } from "./sources/Quantized.js";
import { Literal, LiteralDecorated } from "./sources/QuantizedLiteral.js";
import { Aim } from "./sources/QuantizedAngle.js";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_DIR = path.resolve(__dirname, "sources");
const OUTPUT_DIR = path.resolve(__dirname, "tmp-codegen-output");

// patterns are built with path.resolve(), so on Windows they carry backslashes,
// which glob would otherwise read as escape characters and match nothing
const globSync = (pattern: string) => glob.sync(pattern, { windowsPathsNoEscape: true });

describe("schema-codegen", () => {
    beforeEach(() => {
        rimraf.sync(OUTPUT_DIR);
        fs.mkdirSync(OUTPUT_DIR);
    });

    afterEach(() => {
        rimraf.sync(OUTPUT_DIR)
        fs.mkdirSync(OUTPUT_DIR);
    });

    it("should generate 3 files", async () => {
        const inputFiles = [
            path.resolve(INPUT_DIR, "BaseSchema.ts"),
            path.resolve(INPUT_DIR, "Inheritance.ts"),
            path.resolve(INPUT_DIR, "Inheritance2.ts"),
        ];

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(3, outputFiles.length);
    });

    it("should generate all files from wildcard path", async () => {
        const input = path.resolve(INPUT_DIR, 'wildcard', "*");

        generate("csharp", { files: [input], output: OUTPUT_DIR });

        const inputFiles = globSync(input);
        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(outputFiles.length, inputFiles.length);
    });

    it("should auto-import related schema files", async () => {
        const inputFiles = globSync(path.resolve(INPUT_DIR, "Inheritance.ts"));

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should support using 'type' along with `defineTypes` (deprecated)", async () => {
        const inputFiles = globSync(path.resolve(INPUT_DIR, "DefineTypes.js"));

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(1, outputFiles.length);
    });

    it("should support generating abstract classes with no fields", async () => {
        const inputFiles = globSync(
            path.resolve(INPUT_DIR, "AbstractSchema.ts")
        );

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR, });

        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should support generating enums", async () => {
        const inputFiles = globSync(path.resolve(INPUT_DIR, "Enums.ts"));
        generate("csharp", { files: inputFiles, output: OUTPUT_DIR, });

        const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should emit native C# enum for positive-int enums, struct otherwise", () => {
        const inputFiles = globSync(path.resolve(INPUT_DIR, "EnumsAllKinds.ts"));
        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const read = (name: string) => fs.readFileSync(path.resolve(OUTPUT_DIR, name), "utf8");

        // implicit index ints -> native enum
        const implicitInt = read("ImplicitInt.cs");
        assert.match(implicitInt, /public enum ImplicitInt : int \{/);
        assert.match(implicitInt, /A = 0,/);
        assert.match(implicitInt, /B = 1,/);
        assert.match(implicitInt, /C = 2,/);
        assert.doesNotMatch(implicitInt, /public struct/);

        // explicit positive ints -> native enum
        const explicitInt = read("ExplicitInt.cs");
        assert.match(explicitInt, /public enum ExplicitInt : int \{/);
        assert.match(explicitInt, /X = 10,/);
        assert.match(explicitInt, /Y = 20,/);
        assert.match(explicitInt, /Z = 30,/);
        assert.doesNotMatch(explicitInt, /public struct/);

        // string values -> struct with string consts (unchanged)
        const stringEnum = read("StringEnum.cs");
        assert.match(stringEnum, /public struct StringEnum \{/);
        assert.match(stringEnum, /public const string Foo = "foo";/);
        assert.match(stringEnum, /public const string Bar = "bar";/);
        assert.doesNotMatch(stringEnum, /public enum/);

        // float values -> struct with float consts (unchanged)
        const floatEnum = read("FloatEnum.cs");
        assert.match(floatEnum, /public struct FloatEnum \{/);
        assert.match(floatEnum, /public const float Half = 0\.5;/);
        assert.match(floatEnum, /public const float OneAndHalf = 1\.5;/);
        assert.doesNotMatch(floatEnum, /public enum/);
    });

    describe("Metadata.setFields", () => {
        it("single structure ", async () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "Metadata.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts"));
            assert.strictEqual(1, outputFiles.length);
        });
    });

    describe("plain schema()", () => {
        it("single structure ", async () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "PlainSchema.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts"));
            assert.strictEqual(1, outputFiles.length);
        });

        it("using extends", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "PlainSchemaExtends.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts"));

            assert.strictEqual(3, outputFiles.length);
        });

        it("with map", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "PlainSchemaMap.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts"));

            assert.strictEqual(2, outputFiles.length);
        });

        it("should infer class names from the variable when no name arg is given", () => {
            // Exercises the parser's name-inference branch (no explicit name arg)
            // for both `schema({...})` and `Base.extend({...})`.
            const inputFiles = globSync(path.resolve(INPUT_DIR, "InferName.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["Vec3.ts", "Vec4.ts"]);

            // `.extend()` with no name → inferred "Vec4", extending the inferred "Vec3".
            const vec4 = fs.readFileSync(path.resolve(OUTPUT_DIR, "Vec4.ts"), "utf8");
            assert.match(vec4, /class Vec4 extends Vec3/);
        });
    });

    describe("invalid/error", () => {
        it("should not throw error", async () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "Invalid.ts"));
            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts"));
            outputFiles.map((file) => {
                console.log(fs.readFileSync(file).toString());
            })
        });
    });

    describe("builder as collection element", () => {
        it("throws pointing at the type-name form instead of emitting an undefined child type", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "BuilderChild.ts"));
            assert.throws(
                () => generate("csharp", { files: inputFiles, output: OUTPUT_DIR }),
                /field 'items'.*t\.array\("string"\)/,
            );
        });
    });

    describe("deprecated fields", () => {
        const gen = (fixture: string, lang: string) => {
            fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
            generate(lang, { files: [path.resolve(INPUT_DIR, fixture)], output: OUTPUT_DIR });
            const ext = (lang === "csharp") ? "cs" : lang;
            return fs.readFileSync(path.resolve(OUTPUT_DIR, `Versioned.${ext}`)).toString();
        };

        it("`.deprecated()` generates the same output as `@deprecated()`", () => {
            for (const lang of ["csharp", "dart"]) {
                const decorator = gen("DeprecatedDecorator.ts", lang);
                const builder = gen("DeprecatedBuilder.ts", lang);
                assert.strictEqual(builder, decorator, lang);
                assert.match(decorator, /old.*deprecated|deprecated.*old/is);
            }
        });

        it("marks both `.deprecated()` and `.deprecated(false)`, and nothing else", () => {
            const out = gen("DeprecatedBuilder.ts", "csharp");
            const obsolete = [...out.matchAll(/Obsolete\("field '(\w+)'/g)].map((m) => m[1]);
            assert.deepStrictEqual(obsolete, ["old", "soft"]);

            const after = fs.readFileSync(path.resolve(OUTPUT_DIR, "After.cs")).toString();
            assert.doesNotMatch(after, /Obsolete/, "trailing .deprecated() leaked into the next schema()");
        });
    });

    // Codegen must terminate on ANY class graph the parser can produce. These
    // guard the inheritance-chain walks (getStructures/isSchemaClass/
    // getInheritanceTree/postProcessing) against the malformed inputs that used
    // to hang or crash: a nameless half-formed Class, a cyclic `extends` chain,
    // and an unresolved base class.
    describe("malformed class graph (must not hang/crash)", () => {
        function classOf(name: string | undefined, ext: string | undefined) {
            const k = new Class();
            k.name = name as any;
            k.extends = ext as any;
            return k;
        }

        it("excludes a nameless, half-formed class instead of looping", () => {
            const ctx = new Context();
            ctx.addStructure(classOf(undefined, undefined)); // would self-match in getParentClass
            ctx.addStructure(classOf("Vec5", "Schema"));

            const { classes } = ctx.getStructures();
            assert.deepStrictEqual(classes.map((c) => c.name), ["Vec5"]);
        });

        it("terminates on a cyclic extends chain", () => {
            const ctx = new Context();
            ctx.addStructure(classOf("A", "B"));
            ctx.addStructure(classOf("B", "A")); // neither descends from Schema

            const { classes } = ctx.getStructures();
            assert.strictEqual(classes.length, 0);
        });

        it("getInheritanceTree stops at an unresolved base instead of crashing", () => {
            const a = classOf("A", "DoesNotExist");
            assert.deepStrictEqual(getInheritanceTree(a, [a]).map((c) => c.name), ["A"]);
        });

        it("generates a chained schema().extend() without hanging", () => {
            // The outer `.extend`'s base is a call (not an identifier), so it
            // can't be named — codegen drops that layer (warns) but must finish.
            const inputFiles = globSync(path.resolve(INPUT_DIR, "InferNameChain.ts"));
            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.ts")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles, ["Vec5.ts"]);
            assert.match(fs.readFileSync(path.resolve(OUTPUT_DIR, "Vec5.ts"), "utf8"), /class Vec5 extends Schema/);
        });
    });

    describe("swift", () => {
        const read = (name: string) =>
            fs.readFileSync(path.resolve(OUTPUT_DIR, name), "utf8");

        it("should emit SchemaRef façades", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "SwiftSchema.ts"));
            generate("swift", { files: inputFiles, output: OUTPUT_DIR });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.swift")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["Item.swift", "Player.swift", "TestRoomState.swift"]);

            const player = read("Player.swift");
            assert.match(player, /import Colyseus/);
            assert.match(player, /public final class Player: SchemaRef, @unchecked Sendable \{/);
            assert.match(player, /public var x: Double \{ view\["x"\] \}/);
            assert.match(player, /public var isBot: Bool \{ view\.bool\("isBot"\) \}/);
            assert.match(player, /public var items: ArraySchema<Item> \{ arrayOf\("items"\) \}/);
            assert.match(player, /public var scores: MapSchema<Double> \{ mapOf\("scores"\) \}/);
            assert.match(player, /public var tags: ArraySchema<String> \{ arrayOf\("tags"\) \}/);

            const state = read("TestRoomState.swift");
            assert.match(state, /public var players: MapSchema<Player> \{ mapOf\("players"\) \}/);
            assert.match(state, /public var host: Player\? \{ refOf\("host"\) \}/);
            assert.match(state, /public var currentTurn: String \{ view\.string\("currentTurn"\) \?\? "" \}/);
        });

        it("should leave an extended class open to subclass", () => {
            const inputFiles = [
                path.resolve(INPUT_DIR, "BaseSchema.ts"),
                path.resolve(INPUT_DIR, "Inheritance.ts"),
            ];
            generate("swift", { files: inputFiles, output: OUTPUT_DIR });

            assert.match(read("BaseSchema.swift"), /open class BaseSchema: SchemaRef, @unchecked Sendable \{/);
            assert.match(read("Inheritance.swift"), /public final class Inheritance: BaseSchema, @unchecked Sendable \{/);
        });

        it("should bundle every structure into a single file", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "SwiftSchema.ts"));
            generate("swift", { files: inputFiles, output: OUTPUT_DIR, bundle: true });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.swift")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles, ["Schema.swift"]);

            const bundle = read("Schema.swift");
            for (const klass of ["Item", "Player", "TestRoomState"]) {
                assert.match(bundle, new RegExp(`class ${klass}`));
            }
            // One import for the whole file, not one per structure.
            assert.strictEqual(bundle.match(/import Colyseus/g)?.length, 1);
        });

        it("should stand a namespace in as a caseless enum", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "SwiftSchema.ts"));
            generate("swift", { files: inputFiles, output: OUTPUT_DIR, bundle: true, namespace: "Lab" });

            const bundle = read("Lab.swift");
            assert.match(bundle, /public enum Lab \{\}/);
            assert.match(bundle, /extension Lab \{/);
            assert.match(bundle, /    public final class Player: SchemaRef, @unchecked Sendable \{/);
        });

        it("should escape a field name that is a Swift keyword", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "SwiftKeywords.ts"));
            generate("swift", { files: inputFiles, output: OUTPUT_DIR });

            const out = read("KeywordState.swift");
            assert.match(out, /public var `class`: String/);
            assert.match(out, /public var `repeat`: Double/);
            assert.match(out, /public var normal: Double/);
        });

        it("should emit enums as caseless enums of constants", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "Enums.ts"));
            generate("swift", { files: inputFiles, output: OUTPUT_DIR });

            const shipType = read("ShipType.swift");
            assert.match(shipType, /public enum ShipType \{/);
            assert.match(shipType, /public static let Transport = 0/);
            assert.match(shipType, /public static let Colonizer = 2/);

            const messageType = read("MessageType.swift");
            assert.match(messageType, /public static let DeployMiner = "deploy-miner"/);
        });
    });

    describe("haxe", () => {
        const generated = () => {
            generate("haxe", { files: [path.resolve(INPUT_DIR, "HaxeFields.ts")], output: OUTPUT_DIR });
            return fs.readFileSync(path.resolve(OUTPUT_DIR, "HxState.hx"), "utf8");
        };

        it("should type fields as the Haxe SDK decodes them", () => {
            const out = generated();
            assert.match(out, /public var num: Float = 0;/);
            assert.match(out, /public var f32: Float = 0;/);
            assert.match(out, /public var small: Int = 0;/);
            assert.match(out, /public var tick: Int = 0;/);
            assert.match(out, /public var big: haxe\.Int64 = 0;/);
            assert.match(out, /public var floats: ArraySchema<Float> = new ArraySchema<Float>\(\);/);
            assert.match(out, /public var counts: MapSchema<Int> = new MapSchema<Int>\(\);/);
            assert.doesNotMatch(out, /Dynamic|UInt/);
        });

        it("should carry `.default()` values over", () => {
            const out = generated();
            assert.match(out, /public var alive: Bool = true;/);
            assert.match(out, /public var campId: Int = -1;/);
            assert.match(out, /public var radius: Float = 0\.5;/);
            assert.match(out, /public var mode: Int = 2;/);
            assert.ok(out.includes(`public var label: String = "say \\"hi\\"\\n";`), out);
        });

        it("should rename a field that is a Haxe keyword", () => {
            const out = generated();
            assert.match(out, /\/\/ "cast" on the wire \(a Haxe keyword\)\n\t@:type\("uint8"\)\n\tpublic var cast_: Int = 0;/);
            assert.match(out, /public var class_: String = "";/);
            assert.doesNotMatch(out, /public var (cast|class):/);
        });
    });

    describe("dart", () => {
        const read = (name: string) =>
            fs.readFileSync(path.resolve(OUTPUT_DIR, name), "utf8");

        it("should emit SchemaRef façades", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "DartSchema.ts"));
            generate("dart", { files: inputFiles, output: OUTPUT_DIR });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.dart")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["Item.dart", "Player.dart", "TestRoomState.dart"]);

            const player = read("Player.dart");
            assert.match(player, /import 'package:colyseus\/colyseus\.dart';/);
            assert.match(player, /import 'Item\.dart';/);
            assert.match(player, /final class Player extends SchemaRef \{/);
            assert.match(player, /Player\(super\.handle\);/);
            assert.match(player, /double get x => view\['x'\];/);
            assert.match(player, /bool get isBot => view\.getBool\('isBot'\);/);
            assert.match(player, /ArraySchema<Item> get items => arrayOf\('items', Item\.new\);/);
            assert.match(player, /MapSchema<double> get scores => primitiveMapOf\('scores'\);/);
            assert.match(player, /ArraySchema<String> get tags => primitiveArrayOf\('tags'\);/);

            // Callbacks register through StateCallbacks (C#-style), not
            // through generated extensions.
            assert.doesNotMatch(player, /extension /);

            const state = read("TestRoomState.dart");
            assert.match(state, /MapSchema<Player> get players => mapOf\('players', Player\.new\);/);
            assert.match(state, /Player\? get host => refOf\('host', Player\.new\);/);
            assert.match(state, /String get currentTurn => view\.getString\('currentTurn'\) \?\? '';/);
            assert.doesNotMatch(state, /extension /);
        });

        it("should mark extended classes `base` and import the parent", () => {
            const inputFiles = [
                path.resolve(INPUT_DIR, "BaseSchema.ts"),
                path.resolve(INPUT_DIR, "Inheritance.ts"),
            ];
            generate("dart", { files: inputFiles, output: OUTPUT_DIR });

            const base = read("BaseSchema.dart");
            assert.match(base, /base class BaseSchema extends SchemaRef \{/);

            const child = read("Inheritance.dart");
            assert.match(child, /import 'BaseSchema\.dart';/);
            assert.match(child, /final class Inheritance extends BaseSchema \{/);
        });

        it("should bundle every structure into a single file", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "DartSchema.ts"));
            generate("dart", { files: inputFiles, output: OUTPUT_DIR, bundle: true });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.dart")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles, ["schema.dart"]);

            const bundle = read("schema.dart");
            assert.match(bundle, /final class Item extends SchemaRef \{/);
            assert.match(bundle, /final class Player extends SchemaRef \{/);
            assert.match(bundle, /final class TestRoomState extends SchemaRef \{/);
            // one shared import, no per-class import lines
            assert.strictEqual(bundle.match(/import '/g)?.length, 1);
        });

        it("should emit enums as const holders", () => {
            const inputFiles = globSync(path.resolve(INPUT_DIR, "Enums.ts"));
            generate("dart", { files: inputFiles, output: OUTPUT_DIR });

            const shipType = read("ShipType.dart");
            assert.match(shipType, /abstract final class ShipType \{/);
            assert.match(shipType, /static const Transport = 0;/);
            assert.match(shipType, /static const Colonizer = 2;/);

            const messageType = read("MessageType.dart");
            assert.match(messageType, /static const DeployMiner = "deploy-miner";/);
        });
    });

    describe("field indexes", () => {
        const NOSYNC = path.resolve(INPUT_DIR, "NoSync.ts");

        // name -> [Type] index of every field a generated C# file declares
        const csharpIndexes = (file: string) => Object.fromEntries(
            [...fs.readFileSync(path.resolve(OUTPUT_DIR, file), "utf8")
                .matchAll(/\[(?:global::Colyseus\.Schema\.)?Type\((\d+),[^\n]*\]\s*\n\s*public \S+ @?(\w+) =/g)]
                .map((m) => [m[2], Number(m[1])])
        );

        // name -> index as assigned by the real runtime, inherited fields included
        const runtimeIndexes = (klass: any) => {
            const metadata = klass[Symbol.metadata];
            const indexes: Record<string, number> = {};
            for (let i = 0; i <= metadata[$numFields]; i++) { indexes[metadata[i].name] = i; }
            return indexes;
        };

        it("leaves .noSync() fields out of the model every target generates from", () => {
            const { classes } = parseFiles([NOSYNC], "type", new Context());
            const fields = Object.fromEntries(classes.map((k) => [k.name, k.properties.map((p) => p.name)]));
            assert.deepStrictEqual(fields.NoSyncParent, ["x", "y"]);
            assert.deepStrictEqual(fields.NoSyncChild, ["hp", "name"]);
        });

        it("matches the runtime's indexes across .noSync() and .extend()", () => {
            generate("csharp", { files: [NOSYNC], output: OUTPUT_DIR });
            assert.deepStrictEqual(csharpIndexes("NoSyncParent.cs"), runtimeIndexes(NoSyncParent));
            assert.deepStrictEqual(
                { ...csharpIndexes("NoSyncParent.cs"), ...csharpIndexes("NoSyncChild.cs") },
                runtimeIndexes(NoSyncChild),
            );
        });

        it("does not number function-valued members as fields", () => {
            generate("csharp", { files: [NOSYNC], output: OUTPUT_DIR });
            assert.deepStrictEqual(csharpIndexes("FunctionMembers.cs"), runtimeIndexes(FunctionMembers));
        });
    });

    describe("quantized", () => {
        const source = (name: string) => path.resolve(INPUT_DIR, `${name}.ts`);

        // class -> field -> the quantization codegen extracted, for every quantized field
        const parsed = (file: string): Record<string, Record<string, any>> => Object.fromEntries(
            parseFiles([source(file)], "type", new Context()).classes.map((k) => [
                k.name,
                Object.fromEntries(k.properties.filter((p) => p.quantized).map((p) => [p.name, p.quantized])),
            ])
        );

        // field -> the same, as the real runtime resolved it
        const runtime = (klass: any) => {
            const metadata = klass[Symbol.metadata];
            const fields: Record<string, any> = {};
            for (let i = 0; i <= metadata[$numFields]; i++) {
                const q = metadata[i].type?.quantized;
                if (q) { fields[metadata[i].name] = { min: q.min, max: q.max, bits: q.bits, wrap: q.wrap }; }
            }
            return fields;
        };

        it("reads literal and constant-Math options, defaulting to 16-bit clamp", () => {
            const { Literal, LiteralDecorated } = parsed("QuantizedLiteral");
            assert.deepStrictEqual(Literal, {
                axis: { min: -1, max: 1, bits: 16, wrap: false },
                heading: { min: 0, max: Math.PI * 2, bits: 8, wrap: true },
                speed: { min: 0, max: 20, bits: 32, wrap: false },
            });
            assert.deepStrictEqual(LiteralDecorated, { lean: { min: -0.5, max: 0.5, bits: 8, wrap: false } });
        });

        it("desugars t.angle() into a wrapping full circle", () => {
            assert.deepStrictEqual(parsed("QuantizedAngle").Aim, {
                yaw: { min: 0, max: Math.PI * 2, bits: 16, wrap: true },
                coarse: { min: 0, max: Math.PI * 2, bits: 8, wrap: true },
            });
        });

        it("emits t.angle() as a quantized field in C# and Haxe", () => {
            generate("csharp", { files: [source("QuantizedAngle")], output: OUTPUT_DIR });
            generate("haxe", { files: [source("QuantizedAngle")], output: OUTPUT_DIR });
            const cs = fs.readFileSync(path.resolve(OUTPUT_DIR, "Aim.cs"), "utf8");
            const hx = fs.readFileSync(path.resolve(OUTPUT_DIR, "Aim.hx"), "utf8");
            assert.doesNotMatch(cs, /undefined|"angle"/);
            assert.doesNotMatch(hx, /undefined|"angle"/);
            assert.match(cs, /Type\(0, "quantized", QuantizeMin = 0, QuantizeMax = 6\.283185307179586, QuantizeBits = 16, QuantizeWrap = true\)\]\s*public double yaw /);
            assert.match(hx, /"quantized", \{min: 0, max: 6\.283185307179586, bits: 16, mode: 1\}\)\s*public var yaw: Float/);
        });

        it("resolves bounds held in consts: local, imported, aliased, re-exported and chained", () => {
            const { pitch, span, tilt, coarse } = parsed("Quantized").Look;
            assert.deepStrictEqual(pitch, { min: -1.5, max: 1.5, bits: 16, wrap: false });
            assert.deepStrictEqual(span, { min: 0, max: Math.PI * 2, bits: 16, wrap: true });
            assert.deepStrictEqual(tilt, { min: 0, max: 1.5, bits: 16, wrap: false });
            assert.deepStrictEqual(coarse, { min: 0, max: Math.PI * 2, bits: 8, wrap: true });
        });

        it("matches the runtime's descriptor for every quantized field", () => {
            assert.deepStrictEqual(parsed("QuantizedLiteral").Literal, runtime(Literal));
            assert.deepStrictEqual(parsed("QuantizedLiteral").LiteralDecorated, runtime(LiteralDecorated));
            assert.deepStrictEqual(parsed("QuantizedAngle").Aim, runtime(Aim));
            assert.deepStrictEqual(parsed("Quantized").Look, runtime(Look));
        });

        it("refuses a bound held in a `let`", () => {
            assert.throws(
                () => parseFiles([path.resolve(INPUT_DIR, "QuantizedMutable.ts")], "type", new Context()),
                /field 'value' — `max` is not a constant expression/,
            );
        });
    });

    describe("csharp", () => {
        const gen = (klass: string, namespace?: string) => {
            generate("csharp", { files: [path.resolve(INPUT_DIR, "CSharpFields.ts")], output: OUTPUT_DIR, namespace });
            return fs.readFileSync(path.resolve(OUTPUT_DIR, `${klass}.cs`), "utf8");
        };
        // a field's declaration line
        const field = (cs: string, name: string) =>
            cs.match(new RegExp(`^\\s*public \\S+ @?${name} = .*;$`, "m"))?.[0].trim();

        it("maps `number` to double", () => {
            const cs = gen("CsState");
            assert.match(field(cs, "num"), /^public double num /);
            assert.match(field(cs, "scores"), /MapSchema<double> scores /);
        });

        it("maps float32 to double, so a client-side write keeps the value JS would hold", () => {
            const cs = gen("CsState");
            assert.strictEqual(field(cs, "f32"), "public double f32 = default(double);");
            assert.match(cs, /\[global::Colyseus\.Schema\.Type\(\d+, "float32"\)\]\s*public double f32 /);
        });

        it("names every SDK type through global:: so a `.Schema` namespace can't shadow it", () => {
            const cs = gen("CsState", "Game.Schema");
            assert.match(cs, /class CsState : global::Colyseus\.Schema\.Schema \{/);
            const unqualified = cs
                .replace(/^namespace .*$/m, "")
                .replace(/global::[\w.]+/g, "")
                .match(/\b(Schema|ArraySchema|MapSchema|Type|Preserve)\b/g);
            assert.strictEqual(unqualified, null);
        });

        it("initializes collections empty and leaves a child schema null", () => {
            const cs = gen("CsState");
            assert.match(field(cs, "items"), /items = new global::Colyseus\.Schema\.ArraySchema<CsItem>\(\);$/);
            assert.match(field(cs, "bytes"), /bytes = new global::Colyseus\.Schema\.ArraySchema<byte>\(\);$/);
            assert.match(field(cs, "byId"), /byId = new global::Colyseus\.Schema\.MapSchema<CsItem>\(\);$/);
            assert.strictEqual(field(cs, "child"), "public CsItem child = null;");
        });

        it("emits .default() values — literals and consts — else the type's default", () => {
            const cs = gen("CsState");
            assert.strictEqual(field(cs, "alive"), "public bool alive = true;");
            assert.strictEqual(field(cs, "campId"), "public sbyte campId = -1;");
            assert.strictEqual(field(cs, "radius"), "public double radius = 0.5;");
            assert.strictEqual(field(cs, "speed"), "public double speed = 1.25;");
            assert.strictEqual(field(cs, "label"), 'public string label = "say \\"hi\\"\\n";');
            assert.strictEqual(field(cs, "mode"), "public byte mode = 2;");
        });

        it("emits a decorator field's literal initializer as its default", () => {
            const cs = gen("CsDecorated");
            assert.strictEqual(field(cs, "status"), 'public string status = "ready";');
            assert.strictEqual(field(cs, "count"), "public byte count = 3;");
            assert.strictEqual(field(cs, "seed"), "public double seed = default(double);");
        });

        it("escapes a field named after a C# keyword", () => {
            assert.strictEqual(field(gen("CsState"), "class"), "public string @class = default(string);");
        });
    });

    // https://github.com/colyseus/schema/issues/186 — a bare specifier that a
    // tsconfig `paths`/`baseUrl` maps onto first-party source used to be dropped
    // silently, so the schemas it exported never reached the generated output.
    describe("tsconfig path aliases", () => {
        const ALIAS_DIR = path.resolve(INPUT_DIR, "aliased");

        it("follows `paths`, `baseUrl` and barrel re-exports", () => {
            generate("csharp", { files: [path.resolve(ALIAS_DIR, "Room.ts")], output: OUTPUT_DIR });

            // the exact list also pins that `nanoid` was not followed into
            // node_modules, and that the library's own source stayed out
            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["AliasedEnemy.cs", "AliasedPlayer.cs", "AliasedRoomState.cs"]);

            const state = fs.readFileSync(path.resolve(OUTPUT_DIR, "AliasedRoomState.cs"), "utf8");
            assert.match(state, /AliasedPlayer player/);
            assert.match(state, /AliasedEnemy enemy/);
        });

        it("accepts an explicit --tsconfig for sources outside the aliased project", () => {
            generate("csharp", {
                files: [path.resolve(INPUT_DIR, "aliased-external", "OutsideRoom.ts")],
                output: OUTPUT_DIR,
                tsconfig: path.resolve(ALIAS_DIR, "tsconfig.json"),
            });

            const outputFiles = globSync(path.resolve(OUTPUT_DIR, "*.cs")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["AliasedPlayer.cs", "OutsideRoomState.cs"]);
        });

        it("throws when an explicit --tsconfig does not exist", () => {
            assert.throws(() => generate("csharp", {
                files: [path.resolve(ALIAS_DIR, "Room.ts")],
                output: OUTPUT_DIR,
                tsconfig: path.resolve(ALIAS_DIR, "nope.json"),
            }), /nope\.json/);
        });
    });

});
