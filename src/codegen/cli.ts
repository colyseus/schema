import * as fs from "fs";
import * as path from "path";
import argv from "./argv";
import { parseFiles } from "./parser";
import { File } from "./types";

function displayHelp() {
    console.log(`\nschema-codegen [path/to/Schema.ts]

Usage (C#/Unity)
    schema-codegen src/Schema.ts --output client-side/ --csharp --namespace MyGame.Schema

Valid options:
    --output: fhe output directory for generated client-side schema files
    --csharp: generate files for C#/Unity
    --cpp: generate files for C++
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
if (args.csharp) {
    generatorId = 'csharp';

} else if (args.haxe) {
    generatorId = 'haxe';

} else if (args.cpp) {
    generatorId = 'cpp';
}

if (!args.output || !fs.existsSync(args.output)) {
    console.error("You must provide a valid (and existing) --output directory.");
    displayHelp();
}

let generator;
try {
    generator = require('./' + generatorId).generate;
} catch (e) {
    console.error("You must provide a valid generator as argument, such as: --csharp, --haxe or --cpp");
    displayHelp();
}

const classes = parseFiles(args._);
const files = generator(classes, args);

files.forEach((file: File) => {
    const outputPath = path.resolve(args.output, file.name);
    fs.writeFileSync(outputPath, file.content);
    console.log("generated:", file.name);
});