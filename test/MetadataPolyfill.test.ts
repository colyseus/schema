import * as assert from "assert";
import { execFileSync } from "child_process";

/**
 * Regression guard for #233: a core-js `esnext.function.metadata` polyfill sets
 * `Function.prototype[Symbol.metadata] = null`, which every class without its
 * own slot then inherits. `agora-rtc-sdk-ng` bundles one, so the whole package
 * broke on any page importing it.
 *
 * The polyfill installs a non-configurable property and has to be in place
 * before `src/` is evaluated, so it can't be set up and torn down in-process —
 * the scenarios run in a child process instead, once per `useDefineForClassFields`
 * setting, since the metadata slot must not depend on class-field emit.
 */
describe("Function.prototype[Symbol.metadata] polyfill", () => {
    const configs = {
        "useDefineForClassFields: false": "tsconfig.test.json",
        "useDefineForClassFields: true": "test/metadata-polyfill/tsconfig.define-true.json",
    };

    for (const [name, tsconfig] of Object.entries(configs)) {
        it(`is tolerated with ${name}`, function () {
            this.timeout(30000); // cold tsx start

            try {
                execFileSync("node", [
                    "node_modules/tsx/dist/cli.mjs",
                    "--tsconfig", tsconfig,
                    "--import", "./test/metadata-polyfill/preload.mjs",
                    "test/metadata-polyfill/scenarios.ts",
                ], { encoding: "utf8", stdio: "pipe" });
            } catch (e: any) {
                assert.fail(`scenarios failed under ${name}:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
            }
        });
    }
});
