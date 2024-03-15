import { Schema } from "./";
import { ChangeTree } from "./encoder/ChangeTree";
import { $changes } from "./types/symbols";

export function dumpChanges(schema: Schema) {
    const changeTrees: ChangeTree[] = [schema[$changes]];
    let numChangeTrees = 1;

    const dump = {};
    let currentStructure = dump;

    for (let i = 0; i < numChangeTrees; i++) {
        const changeTree = changeTrees[i];

        changeTree.changes.forEach((_, fieldIndex) => {
            const ref = changeTree.ref;

            const field = ((ref as Schema)['metadata'])
                ? ref['metadata'][fieldIndex]
                : ref['$indexes'].get(fieldIndex);

            currentStructure[field] = changeTree.getValue(fieldIndex);
        });

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