import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as rimraf from "rimraf";
import * as glob from "glob";
import * as assert from "assert";
import { generate, generators } from "../../src/codegen/api.js";
import { Context, Class, getInheritanceTree } from "../../src/codegen/types.js";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** `glob` matches forward-slash patterns only: normalise Windows paths first. */
const globSync = (pattern: string) => glob.sync(pattern.split(path.sep).join("/"));

const INPUT_DIR = path.resolve(__dirname, "sources");
const OUTPUT_DIR = path.resolve(__dirname, "tmp-codegen-output");

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

    describe("number-keyed maps", () => {
        // Emitted file name for a class, per target.
        const extensions: Record<string, string> = {
            csharp: "cs", cpp: "hpp", haxe: "hx", ts: "ts", js: "js", java: "java",
            lua: "lua", c: "h", gdscript: "gd", dart: "dart", swift: "swift",
        };
        const toSnakeCase = (s: string) => s.replace(/([A-Z])/g, (_, p1, offset) => (offset > 0 ? "_" : "") + p1.toLowerCase());
        const fileFor = (lang: string, className: string) =>
            `${lang === "c" ? toSnakeCase(className) : className}.${extensions[lang]}`;

        const gen = (fixture: string, lang: string, className: string) => {
            fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
            generate(lang, { files: [path.resolve(INPUT_DIR, fixture)], output: OUTPUT_DIR });
            return fs.readFileSync(path.resolve(OUTPUT_DIR, fileFor(lang, className)), "utf8");
        };

        // The three fixture classes differ only by name: fold the names (and
        // their SCREAMING / snake_case forms in C guards and identifiers) so
        // the outputs can be compared byte-for-byte.
        const foldName = (out: string) => out
            .replace(/Keyed(Decorator|Builder|Control)/g, "Keyed")
            .replace(/KEYED(DECORATOR|BUILDER|CONTROL)/g, "KEYED")
            .replace(/keyed_(decorator|builder|control)/g, "keyed");

        // Every line mentioning the string-keyed control field, plus the line
        // right before it (the C#/Java attribute lives there) — except for
        // lines that list every field (Lua `_fields_by_index`, C++ `_indexes`),
        // whose predecessor is legitimately a number-keyed field.
        const controlLines = (out: string) => {
            const lines = out.split("\n");
            return lines.flatMap((line, i) => {
                if (!line.includes("byName")) { return []; }
                const onlyControl = !line.includes("byId") && !line.includes("scores");
                return onlyControl ? [lines[i - 1], line] : [line];
            });
        };

        // Number-keyed spelling per target: `byId` is a schema-valued map
        // keyed by "number", `scores` a primitive-valued map keyed by "int32".
        const expectations: Record<string, RegExp[]> = {
            ts: [
                /@type\(\{ map: Item, key: "number" \}\) public byId: MapSchema<Item, number> = new MapSchema<Item, number>\(\);/,
                /@type\(\{ map: "number", key: "int32" \}\) public scores: MapSchema<number, number> = new MapSchema<number, number>\(\);/,
            ],
            js: [
                /type\(\{ map: Item, key: "number" \}\)\(Keyed\w*\.prototype, "byId"\);/,
                /type\(\{ map: "number", key: "int32" \}\)\(Keyed\w*\.prototype, "scores"\);/,
            ],
            csharp: [
                /\[Type\(1, "map", typeof\(MapSchema<Item, float>\), KeyType = "number"\)\]\s+public MapSchema<Item, float> byId = null;/,
                /\[Type\(2, "map", typeof\(MapSchema<float, int>\), "number", KeyType = "int32"\)\]\s+public MapSchema<float, int> scores = null;/,
            ],
            cpp: [
                /MapSchema<Item\*, varint_t> \*byId = new MapSchema<Item\*, varint_t>\(\);/,
                /MapSchema<varint_t, int32_t> \*scores = new MapSchema<varint_t, int32_t>\(\);/,
                /this->byId = \(MapSchema<Item\*, varint_t> \*\)value;/,
                /this->scores = \(MapSchema<varint_t, int32_t> \*\)value;/,
                /this->_keyTypes = \{\{1, "number"\}, \{2, "int32"\}\};/,
            ],
            java: [
                /@SchemaField\("1\/map\/ref\/number"\)\s+public MapSchema<Item, Float> byId = new MapSchema<>\(Item\.class\);/,
                /@SchemaField\("2\/map\/number\/int32"\)\s+public MapSchema<Float, Integer> scores = new MapSchema<>\(\);/,
            ],
            haxe: [
                /@:type\("map", Item, "number"\)\s+public var byId: MapSchema<Item, Dynamic> = new MapSchema<Item, Dynamic>\(\);/,
                /@:type\("map", "number", "int32"\)\s+public var scores: MapSchema<Dynamic, Int> = new MapSchema<Dynamic, Int>\(\);/,
            ],
            lua: [
                /\["byId"\] = \{ map = Item, key = "number" \}/,
                /\["scores"\] = \{ map = "number", key = "int32" \}/,
            ],
            c: [
                /\{1, "byId", COLYSEUS_FIELD_MAP, "map:number", offsetof\(keyed_\w*_t, byId\), &item_vtable, NULL, NULL\}/,
                /\{2, "scores", COLYSEUS_FIELD_MAP, "map:int32", offsetof\(keyed_\w*_t, scores\), NULL, "number", NULL\}/,
            ],
            gdscript: [
                /Colyseus\.Schema\.Field\.new\("byId", Colyseus\.Schema\.MAP, Item, Colyseus\.Schema\.NUMBER\)/,
                /Colyseus\.Schema\.Field\.new\("scores", Colyseus\.Schema\.MAP, Colyseus\.Schema\.NUMBER, Colyseus\.Schema\.INT32\)/,
            ],
            dart: [
                /MapSchema<Item, double> get byId => mapOf\('byId', Item\.new, keyType: 'number'\);/,
                /MapSchema<double, double> get scores => primitiveMapOf\('scores', keyType: 'int32'\);/,
            ],
            swift: [
                /public var byId: MapSchema<Item, Double> \{ mapOf\("byId", keyType: "number"\) \}/,
                /public var scores: MapSchema<Double, Double> \{ mapOf\("scores", keyType: "int32"\) \}/,
            ],
        };

        it("covers every generator", () => {
            assert.deepStrictEqual(Object.keys(expectations).sort(), Object.keys(generators).sort());
        });

        for (const lang of Object.keys(generators)) {
            describe(lang, () => {
                it("emits the key type for number-keyed maps", () => {
                    const out = gen("NumberKeyedMap.ts", lang, "KeyedDecorator");
                    for (const pattern of expectations[lang]) {
                        assert.match(out, pattern);
                    }
                });

                it("leaves the string-keyed control field byte-identical to a source without any `key`", () => {
                    const keyed = gen("NumberKeyedMap.ts", lang, "KeyedDecorator");
                    const control = gen("StringKeyedMap.ts", lang, "KeyedControl");

                    const keyedLines = controlLines(foldName(keyed));
                    assert.ok(keyedLines.length > 0, "control field 'byName' not found in output");
                    assert.deepStrictEqual(keyedLines, controlLines(foldName(control)));
                });

                it("generates the same output from the decorator and the builder forms", () => {
                    const decorator = gen("NumberKeyedMap.ts", lang, "KeyedDecorator");
                    const builder = gen("NumberKeyedMap.ts", lang, "KeyedBuilder");
                    assert.strictEqual(foldName(builder), foldName(decorator));
                });
            });
        }

        it("accepts `key` before the collection kind in the literal", () => {
            // parser looks the kind up by name, not position
            const src = path.resolve(OUTPUT_DIR, "KeyFirst.ts");
            fs.writeFileSync(src, `
import { Schema, type, MapSchema } from "../../../src";
export class KeyFirst extends Schema {
    @type({ key: "uint8", map: "string" }) names = new MapSchema<string, number>();
}
`);
            generate("ts", { files: [src], output: OUTPUT_DIR });
            const out = fs.readFileSync(path.resolve(OUTPUT_DIR, "KeyFirst.ts"), "utf8");
            assert.match(out, /@type\(\{ map: "string", key: "uint8" \}\) public names: MapSchema<string, number>/);
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
