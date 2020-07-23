import * as assert from "assert";

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