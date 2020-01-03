import { Schema } from "./";
import { ChangeTree } from "./ChangeTree";
import { MapSchema } from "./types/MapSchema";
import { ArraySchema } from "./types/ArraySchema";

export function dumpChanges(schema: Schema) {
    const dump = {};

    const $changes: ChangeTree = (schema as any).$changes;
    const fieldsByIndex = schema._fieldsByIndex || {};

    for (const fieldIndex of Array.from($changes.changes)) {
        const field = fieldsByIndex[fieldIndex] || fieldIndex;

        if (schema[field] instanceof MapSchema) {
            // const $changes: ChangeTree = schema[field].$changes;
            dump[field] = dumpChanges(schema[field]);

        } else if (schema[field] instanceof ArraySchema) {
            dump[field] = dumpChanges(schema[field]);

        } else {
            dump[field] = schema[field];
        }

    }

    return dump;
}