import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as rimraf from "rimraf";
import * as glob from "glob";
import * as assert from "assert";
import { generate } from "../../src/codegen/api.js";

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


});
