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

    after(() => rimraf.sync(OUTPUT_DIR));

    it("should generate 3 files", async () => {
        const inputFiles = glob.sync(path.resolve(INPUT_DIR, "*.ts"));

        generate("csharp", {
            files: inputFiles,
            output: OUTPUT_DIR
        });

        const outputFiles = glob.sync(path.resolve(OUTPUT_DIR, "*.cs"));
        assert.equal(3, outputFiles.length);
    });
});