import * as fs from "fs";
import * as path from "path";
import argv from "./argv";
import { parseFiles } from "./parser";
import { File } from "./types";

function displayHelp() {
    console.log(`\nschema-codegen [path/to/Schema.ts]

Usage (C#/Unity)
    schema-codegen src/Schema.ts --output client-side/ --cs --namespace MyGame.Schema

Valid options:
    --output: fhe output directory for generated client-side schema files
    --cs: generate files C#/Unity
    --cpp: generate files C++
    --hx: generate files for Haxe

Optional:
    --namespace: generate namespace on output code`);
    process.exit();
}

const args = argv(process.argv.slice(2));
if (args.help) {
    displayHelp();
}

let generatorId: string;
if (args.cs) {
    generatorId = 'cs';

} else if (args.hx) {
    generatorId = 'hx';

} else if (args.cpp) {
    generatorId = 'cpp';
}

if (!args.output || !fs.existsSync(args.output)) {
    console.error("You must provide a valid (and existing) --output directory.");
    displayHelp();
}

const generator = require('./' + generatorId).generate;
if (!generator) {
    console.error("You must provide a valid generator as argument.");
}
const classes = parseFiles(args._);
const files = generator(classes, args);

files.forEach((file: File) => {
    const outputPath = path.resolve(args.output, file.name);
    fs.writeFileSync(outputPath, file.content);
    console.log("generated:", file.name);
});