import type { Schema } from "./Schema";
import { OPERATION } from "./encoding/spec";
import { $changes } from "./types/symbols";

interface ChangeDump {
    ops: {
        ADD?: number;
        REMOVE?: number;
        REPLACE?: number;
    },
    refs: string[],
}

export function getIndent(level: number) {
    return (new Array(level).fill(0)).map((_, i) =>
        (i === level - 1) ? `└─ ` : `   `
    ).join("");
}

export function dumpChanges(schema: Schema) {
    const $root = schema[$changes].root;

    const dump: ChangeDump = {
        ops: {},
        refs: []
    };

    // for (const refId in $root.changes) {
    let current = $root.changes.next;
    while (current) {
        const changeTree = current.changeTree;
        // skip if ChangeTree is undefined
        if (changeTree === undefined)  {
            current = current.next;
            continue;
        }

        const changes = changeTree.indexedOperations;

        dump.refs.push(`refId#${changeTree.refId}`);
        for (const index in changes) {
            const op = changes[index];
            const opName = OPERATION[op];
            if (!dump.ops[opName as keyof ChangeDump['ops']]) { dump.ops[opName as keyof ChangeDump['ops']] = 0; }
            dump.ops[OPERATION[op] as keyof ChangeDump['ops']]++;
        }
        current = current.next;
    }

    return dump;
}

export function getNextPowerOf2(number: number) {
    // If number is already a power of 2, return it
    if ((number & (number - 1)) === 0) {
        return number;
    }

    // Find the position of the most significant bit
    let msbPosition = 0;
    while (number > 0) {
        number >>= 1;
        msbPosition++;
    }

    // Return the next power of 2
    return 1 << msbPosition;
}