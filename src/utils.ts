import { Schema } from "./Schema";
import { OPERATION } from "./encoding/spec";
import { $changes, $getByIndex } from "./types/symbols";

type ChangeItem = [string, number | string, any?];

interface ChangeDump {
    ops: {
        ADD?: number;
        REMOVE?: number;
        REPLACE?: number;
    },
    refs: string[],
}

export function dumpChanges(schema: Schema) {
    const $root = schema[$changes].root;

    const dump: ChangeDump = {
        ops: {},
        refs: []
    };

    $root.changes.forEach((operations, changeTree) => {
        dump.refs.push(`refId#${changeTree.refId}`);
        operations.forEach((op, index) => {
            const opName = OPERATION[op];
            if (!dump.ops[opName]) { dump.ops[opName] = 0; }
            dump.ops[OPERATION[op]]++;
        });
    });

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