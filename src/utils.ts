import { Schema } from "./Schema";
import { OPERATION } from "./encoding/spec";
import { $changes, $getByIndex } from "./types/symbols";

interface ChangeItem {
    op: string;
    index: number;
    value?: any;
    refId?: number;
}

export function dumpChanges(schema: Schema) {
    const $root = schema[$changes].root;

    const dump = {
        ops: {
            "ADD": 0,
            "REMOVE": 0,
            "REPLACE": 0,
        },
        changes: []
    };

    $root.changes.forEach((operations, changeTree) => {
        operations.forEach((op, index) => {
            dump.ops[OPERATION[op]]++;

            const value = changeTree.getValue(index);
            const type = changeTree.getType(index);
            const refId = value[$changes] && value[$changes].refId;

            const change: ChangeItem = { op: OPERATION[op], index, };

            if (value?.[$changes]?.refId) {
                change.value = { [`#refId`]: refId };
            } else {
                change.value = value;
            }

            dump.changes.push(change);
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