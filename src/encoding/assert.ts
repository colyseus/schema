import type { Schema } from "../Schema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { MapSchema } from "../types/custom/MapSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { Ref } from "../encoder/ChangeTree.js";
import { $descriptors } from "../types/symbols.js";

export class EncodeSchemaError extends Error {}

export function assertType(value: any, type: string, klass: Schema, field: string | number) {
    let typeofTarget: string;
    let allowNull: boolean = false;

    switch (type) {
        case "number":
        case "int8":
        case "uint8":
        case "int16":
        case "uint16":
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "float32":
        case "float64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "bigint64":
        case "biguint64":
            typeofTarget = "bigint";
            break;
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
            return;
        default:
            // skip assertion for custom types
            // TODO: allow custom types to define their own assertions
            return;
    }

    if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`) || ''}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}

export function assertInstanceType(
    value: Ref,
    type: typeof Schema
        | typeof ArraySchema
        | typeof MapSchema
        | typeof CollectionSchema
        | typeof SetSchema,
    instance: Ref,
    field: string | number,
) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${value && (value as any).constructor.name}' was provided in ${instance.constructor.name}#${field}`);
    }
}

// `useDefineForClassFields: true` turns class fields into own properties that
// hide the @type() accessors, so nothing is tracked. Checked once per class,
// from Root.add(), so setters pay nothing extra.
const checkedClasses = new WeakSet<Function>();
export function assertAccessorsNotShadowed(ref: any) {
    const ctor = ref.constructor;
    if (checkedClasses.has(ctor)) { return; }
    const descriptors = ctor[Symbol.metadata]?.[$descriptors];
    for (const field in descriptors) {
        if (descriptors[field].get !== undefined && Object.prototype.hasOwnProperty.call(ref, field)) {
            throw new EncodeSchemaError(`@colyseus/schema: ${ctor.name}.${field} is an own property that hides its synced accessor, so its changes are never tracked. Set "useDefineForClassFields": false (TypeScript, esbuild); in plain JavaScript, assign it in the constructor instead of declaring a class field.`);
        }
    }
    checkedClasses.add(ctor);
}
