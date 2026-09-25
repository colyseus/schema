#!/usr/bin/env node
/**
 * Copy package.json "version" into the `VERSION` constant of
 * src/encoder/ChangeTree.ts (the cross-copy guard compares it at runtime, and
 * test/CrossCopy.test.ts checks the two match).
 *
 * Runs as the npm `version` lifecycle script, so `npm version <x>` updates the
 * constant and stages it in the same commit. `--check` only reports a mismatch.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "src/encoder/ChangeTree.ts");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const source = fs.readFileSync(FILE, "utf8");
const pattern = /^const VERSION = "([^"]*)";/m;
const match = pattern.exec(source);
if (!match) {
    console.error(`sync-version: no \`const VERSION = "…";\` line in ${path.relative(ROOT, FILE)}`);
    process.exit(1);
}

if (match[1] === version) {
    console.log(`sync-version: VERSION already ${version}`);
} else if (process.argv.includes("--check")) {
    console.error(`sync-version: VERSION is ${match[1]}, package.json is ${version}`);
    process.exit(1);
} else {
    fs.writeFileSync(FILE, source.replace(pattern, `const VERSION = "${version}";`));
    console.log(`sync-version: VERSION ${match[1]} -> ${version}`);
}
