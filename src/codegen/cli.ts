import argv from "./argv.js";
import { generate, generators } from "./api.js";

function displayHelp() {
    console.log(`\nschema-codegen [path/to/Schema.ts]

Usage (C#/Unity)
    schema-codegen src/Schema.ts --output client-side/ --csharp --namespace MyGame.Schema

Valid options:
    --output: the output directory for generated client-side schema files
    --bundle: bundle all generated files into a single file

Generators:
${Object.
    keys(generators).
    map((targetId) => (
`    --${targetId}: generate for ${generators[targetId].name}`
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
for (let target in generators) {
    if (args[target]) {
        targetId = target;
    }
}

if (!args.output) {
    console.error("You must provide a valid --output directory.");
    displayHelp();
}

try {
    args.files = args._;
    generate(targetId, {
        files: args._,
        decorator: args.decorator,
        output: args.output,
        namespace: args.namespace,
        bundle: args.bundle
    });

} catch (e) {
    console.error(e.message);
    console.error(e.stack);
    displayHelp();
}
