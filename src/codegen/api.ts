import * as fs from "fs";
import * as path from "path";

import { File } from "./types.js";
import { parseFiles } from "./parser.js";

// Statically import all language generators (for bundling)
import * as csharp from "./languages/csharp.js";
import * as cpp from "./languages/cpp.js";
import * as haxe from "./languages/haxe.js";
import * as ts from "./languages/ts.js";
import * as js from "./languages/js.js";
import * as java from "./languages/java.js";
import * as lua from "./languages/lua.js";
import * as c from "./languages/c.js";
import * as gdscript from "./languages/gdscript.js";

export const generators: Record<string, any> = { csharp, cpp, haxe, ts, js, java, lua, c, gdscript, };

export interface GenerateOptions {
    files: string[],
    output: string;
    decorator?: string;
    namespace?: string;
    bundle?: boolean;
}

export function generate(targetId: string, options: GenerateOptions) {
    const generator = generators[targetId];

    if (!generator) {
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

    // resolve wildcard files
    options.files = options.files.reduce((acc, cur) => {
        if (cur.endsWith("*")) {
            acc.push(...recursiveFiles(cur.slice(0, -1)).filter(filename => /\.(js|ts|mjs)$/.test(filename)));
        } else {
            acc.push(cur)
        }
        return acc;
    }, [])

    const structures = parseFiles(options.files, options.decorator);

    // Post-process classes before generating
    structures.classes.forEach(klass => klass.postProcessing());

    if (options.bundle && generator.renderBundle) {
        // Bundle mode: generate all classes/interfaces/enums into a single file
        const bundled = generator.renderBundle(structures, options);
        const outputPath = path.resolve(options.output, bundled.name);
        fs.writeFileSync(outputPath, bundled.content);
        console.log("generated (bundled):", bundled.name);
    } else {
        // Standard mode: write individual files
        const generatedFiles = generator.generate(structures, options);
        generatedFiles.forEach((file: File) => {
            const outputPath = path.resolve(options.output, file.name);
            fs.writeFileSync(outputPath, file.content);
            console.log("generated:", file.name);
        });
    }
}

function recursiveFiles(dir: string): string[] {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    let collect: string[] = [];
    files.forEach(file => {
        const filename = path.resolve(dir, file.name);
        file.isDirectory() ? collect.push(...recursiveFiles(filename)) : collect.push(filename);
    })
    return collect;
}
