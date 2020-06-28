import { Schema } from "./";
import { OPERATION } from "./spec";
import { MapSchema } from "./types/MapSchema";
import { ChangeTree } from "./changes/ChangeTree";

export function dumpChanges(schema: Schema) {
    const changeTrees: ChangeTree[] = [schema['$changes']];
    let numChangeTrees = 1;

    const dump = {};
    let currentStructure = dump;

    for (let i = 0; i < numChangeTrees; i++) {
        const changeTree = changeTrees[i];

        // TODO: this method doesn't work as expected.

        changeTree.changes.forEach((change) => {
            const ref = changeTree.ref;
            const fieldIndex = change.index;

            const field = (ref instanceof Schema)
                ? ref['_definition'].fieldsByIndex[fieldIndex]
                : (ref instanceof MapSchema)
                    ? ref['$indexes'].get(fieldIndex)
                    : ref['$indexes'][fieldIndex]


            currentStructure[field] = changeTree.getValue(fieldIndex);
        });

    }

    return dump;
}