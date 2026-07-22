import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as rimraf from "rimraf";
import * as glob from "glob";
import * as assert from "assert";
import { generate } from "../../src/codegen/api.js";
import { Context, Class, getInheritanceTree } from "../../src/codegen/types.js";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(3, outputFiles.length);
    });

    it("should generate all files from wildcard path", async () => {
        const input = path.resolve(INPUT_DIR, 'wildcard', "*");

        generate("csharp", { files: [input], output: OUTPUT_DIR });

        const inputFiles = glob.sync(input);
        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(outputFiles.length, inputFiles.length);
    });

    it("should auto-import related schema files", async () => {
        const inputFiles = glob.sync(path.resolve(INPUT_DIR, "Inheritance.ts"));

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should support using 'type' along with `defineTypes` (deprecated)", async () => {
        const inputFiles = glob.sync(path.resolve(INPUT_DIR, "DefineTypes.js"));

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR });

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(1, outputFiles.length);
    });

    it("should support generating abstract classes with no fields", async () => {
        const inputFiles = glob.sync(
            path.resolve(INPUT_DIR, "AbstractSchema.ts")
        );

        generate("csharp", { files: inputFiles, output: OUTPUT_DIR, });

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should support generating enums", async () => {
        const inputFiles = glob.sync(path.resolve(INPUT_DIR, "Enums.ts"));
        generate("csharp", { files: inputFiles, output: OUTPUT_DIR, });

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.strictEqual(2, outputFiles.length);
    });

    it("should emit native C# enum for positive-int enums, struct otherwise", () => {
        const inputFiles = glob.sync(path.resolve(INPUT_DIR, "EnumsAllKinds.ts"));
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
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "Metadata.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts"));
            assert.strictEqual(1, outputFiles.length);
        });
    });

    describe("plain schema()", () => {
        it("single structure ", async () => {
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "PlainSchema.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts"));
            assert.strictEqual(1, outputFiles.length);
        });

        it("using extends", () => {
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "PlainSchemaExtends.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts"));

            assert.strictEqual(3, outputFiles.length);
        });

        it("with map", () => {
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "PlainSchemaMap.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts"));

            assert.strictEqual(2, outputFiles.length);
        });

        it("should infer class names from the variable when no name arg is given", () => {
            // Exercises the parser's name-inference branch (no explicit name arg)
            // for both `schema({...})` and `Base.extend({...})`.
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "InferName.ts"));

            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles.sort(), ["Vec3.ts", "Vec4.ts"]);

            // `.extend()` with no name → inferred "Vec4", extending the inferred "Vec3".
            const vec4 = fs.readFileSync(path.resolve(OUTPUT_DIR, "Vec4.ts"), "utf8");
            assert.match(vec4, /class Vec4 extends Vec3/);
        });
    });

    describe("invalid/error", () => {
        it("should not throw error", async () => {
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "Invalid.ts"));
            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts"));
            outputFiles.map((file) => {
                console.log(fs.readFileSync(file).toString());
            })
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
            const inputFiles = glob.sync(path.resolve(INPUT_DIR, "InferNameChain.ts"));
            generate("ts", { files: inputFiles, output: OUTPUT_DIR, });

            const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.ts")).map((f) => path.basename(f));
            assert.deepStrictEqual(outputFiles, ["Vec5.ts"]);
            assert.match(fs.readFileSync(path.resolve(OUTPUT_DIR, "Vec5.ts"), "utf8"), /class Vec5 extends Schema/);
        });
    });

});
