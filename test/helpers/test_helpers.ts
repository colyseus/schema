import * as assert from "assert";
import * as v8 from "v8";
import * as vm from "vm";

let gc: (() => void) | undefined;

/** Every target collected once nothing but `fn`'s own frame held it. */
export async function collected(fn: () => object[]) {
    if (gc === undefined) {
        v8.setFlagsFromString("--expose-gc"); // `gc()` without the CLI flag
        gc = vm.runInNewContext("gc") as () => void;
    }
    const refs = fn().map((o) => new WeakRef(o));
    // WeakRef targets are kept until the current job ends.
    await new Promise((resolve) => setImmediate(resolve));
    gc(); gc();
    return refs.every((r) => r.deref() === undefined);
}

export const IS_COVERAGE = process.argv.find(arg => arg.indexOf("--recursive") !== -1);

export function assertExecutionTime(time: number, cb: () => void, print: boolean = false) {
    // warm up...
    for (let i = 0; i < 200; i++) {
        cb();
    }

    // allow increased threshold on code coverage
    if (IS_COVERAGE) { time *= 2; }

    // return time taken to execute task
    // const [_, now] = process.hrtime()
    const now = Date.now();
    cb();
    const elapsedTime = Date.now() - now;
    // process.hrtime()[1] - now

    if (print) {
        console.log("assertExecutionTime ->", { elapsedTime });
    }

    assert.ok(elapsedTime <= time, `took ${elapsedTime}ms (expected less than ${time}ms)`)
}