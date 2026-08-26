// Type-only tests: every tsconfig.types*.json, under each compiler package
// named on the command line, all in parallel:
//
//     node test/types/run.mjs typescript typescript-7
//
// Compilers are addressed by package path, never as `tsc`: `typescript-7` is
// an alias package that also ships a `tsc` bin, and npm links whichever it
// installed last into node_modules/.bin (TS 7 today). The build and typecheck
// scripts in package.json spell the path out for the same reason.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const compilers = process.argv.slice(2);
const configs = readdirSync(process.cwd()).filter((f) => /^tsconfig\.types.*\.json$/.test(f)).sort();

const results = await Promise.all(compilers.flatMap((pkg) => configs.map(async (config) => {
    try {
        await run("node", [`node_modules/${pkg}/bin/tsc`, "-p", config]);
        return { pkg, config, ok: true };
    } catch (e) {
        return { pkg, config, ok: false, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
})));

const failed = results.filter((r) => !r.ok);
for (const r of failed) { console.error(`\n✗ ${r.pkg} ${r.config}\n${r.out}`); }
console.log(`${results.length - failed.length}/${results.length} type checks passed`);
process.exit(failed.length ? 1 : 0);
