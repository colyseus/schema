import * as fs from "fs";
import * as path from "path";
import argv from "./argv";
import { parseFiles } from "./parser";
import { File } from "./types";

const supportedTargets = {
    csharp: 'generate for C#/Unity',
    cpp: 'generate for C++',
    haxe: 'generate for Haxe',
    ts: 'generate for TypeScript',
    js: 'generate for JavaScript',
    java: 'generate for Java',
}

function displayHelp() {
    console.log(`\nschema-codegen [path/to/Schema.ts]

Usage (C#/Unity)
    schema-codegen src/Schema.ts --output client-side/ --csharp --namespace MyGame.Schema

Valid options:
    --output: the output directory for generated client-side schema files
${Object.
    keys(supportedTargets).
    map((targetId) => (
`    --${targetId}: ${supportedTargets[targetId]}`
    )).
    join("\n")}

Optional:
    --namespace: generate namespace on output code
    --decorator: custom name for @type decorator to scan for`);
    process.exit();
}

const args = argv(process.argv.slice(2));
if (args.help) {
    displayHelp();
}

let targetId: string;
for (let target in supportedTargets) {
    if (args[target]) {
        targetId = target;
    }
}

let decoratorName = "type";
if (args.decorator) {
    decoratorName = args.decorator;
}

if (!args.output) {
    console.error("You must provide a valid --output directory.");
    displayHelp();
}

let generator;
try {
    generator = require('./languages/' + targetId).generate;
} catch (e) {
    console.error("You must provide a valid generator as argument, such as: --csharp, --haxe or --cpp");
    displayHelp();
}

if (!fs.existsSync(args.output)) {
    console.log("Creating", args.output, "directory");
    fs.mkdirSync(args.output);
}

const classes = parseFiles(args._, decoratorName);
const files = generator(classes, args);

files.forEach((file: File) => {
    const outputPath = path.resolve(args.output, file.name);
    fs.writeFileSync(outputPath, file.content);
    console.log("generated:", file.name);
});
