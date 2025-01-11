import { Schema } from "../Schema";
import { CollectionSchema } from "../types/custom/CollectionSchema";
import { MapSchema } from "../types/custom/MapSchema";
import { SetSchema } from "../types/custom/SetSchema";
import { ArraySchema } from "../types/custom/ArraySchema";
import type { Ref } from "../encoder/ChangeTree";

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
        case "varUint":
        case "varInt":
        case "varFloat32":
        case "varFloat64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "bigInt64":
        case "bigUint64":
        case "varBigUint":
        case "varBigInt":
            typeofTarget = "bigint";
            break;
        case "cstring":
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
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