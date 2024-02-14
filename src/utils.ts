import { Schema } from "./";
import { $changes } from "./Schema";
import { FieldChangeTracker } from "./changes/ChangeTree";

export function dumpChanges(schema: Schema) {
    const changeTrees: FieldChangeTracker[] = [schema[$changes]];
    let numChangeTrees = 1;

    const dump = {};
    let currentStructure = dump;

    for (let i = 0; i < numChangeTrees; i++) {
        const changeTree = changeTrees[i];

        changeTree.changes.forEach((change) => {
            const ref = changeTree.ref;
            const fieldIndex = change.index;

            const field = ((ref as Schema)['metadata'])
                ? ref['metadata'][fieldIndex]
                : ref['$indexes'].get(fieldIndex);

            currentStructure[field] = changeTree.getValue(fieldIndex);
        });

    }

    return dump;
}