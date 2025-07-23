import * as fs from "fs";
import * as path from "path";
import * as rimraf from "rimraf";
import * as glob from "glob";
import * as assert from "assert";
import { generate } from "../../src/codegen/api";

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

    it("should support using 'type' along with `defineTypes`", async () => {
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
