import { Schema } from "./";
import { OPERATION } from "./spec";

export function dumpChanges(schema: Schema) {
    const dump = [];
    const root = schema['$changes'].root;

    root.changes.forEach((changeTree) => {
        const ref = changeTree.ref;

        dump.push({
            ref: changeTree.ref.constructor.name,
            refId: changeTree.refId,
            operations: Array.from(changeTree.changes)
                .reduce((prev, [fieldIndex, op]) => {
                    const key = (ref instanceof Schema)
                        ? ref['_definition'].fieldsByIndex[op.index]
                        : ref['$indexes'].get(fieldIndex);

                    prev[key] = OPERATION[op.op];
                    return prev;
                }, {})
        });
    });

    return dump;
}