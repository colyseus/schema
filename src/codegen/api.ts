import * as fs from "fs";
import * as path from "path";

import { File } from "./types";
import { parseFiles } from "./parser";

export interface GenerateOptions {
    files: string[],
    output: string;
    decorator?: string;
    namespace?: string;
}

export function generate(targetId: string, options: GenerateOptions) {
    let generator: Function;

    try {
        generator = require('./languages/' + targetId).generate;

    } catch (e) {
        throw new Error("You must provide a valid generator as argument, such as: --csharp, --haxe or --cpp");
    }

    if (!fs.existsSync(options.output)) {
        console.log("Creating", options.output, "directory");
        fs.mkdirSync(options.output);
    }

    /**
     * Default `@type()` decorator name
     */
    if (!options.decorator) { options.decorator = "type"; }

    const structures = parseFiles(options.files, options.decorator);

    // Post-process classes before generating
    structures.classes.forEach(klass => klass.postProcessing());

    const files = generator(structures, options);

    files.forEach((file: File) => {
        const outputPath = path.resolve(options.output, file.name);
        fs.writeFileSync(outputPath, file.content);
        console.log("generated:", file.name);
    });
}
