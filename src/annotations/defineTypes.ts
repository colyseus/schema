import { DefinitionType, filter, FilterCallback, filterChildren, FilterChildrenCallback, type } from '.';
import { Schema } from '../Schema';
import { ArraySchema } from '../types/ArraySchema';
import { MapSchema } from '../types/MapSchema';
import { Context, globalContext } from './Context';

export type DefinitionTypeOptions<S extends Schema, R extends Schema, P = any, K = any, V = any> = {
    type: DefinitionType;
    filter?: FilterCallback<S, P, R>;
    filterChildren?: FilterChildrenCallback<S, K, V, R>;
}

const isPrimitiveType = (type: any)  => typeof type === "string" || Schema.is(type);
const isDefinitionType = (type: any): type is DefinitionType => isPrimitiveType(type) || ArraySchema.is(type)  || MapSchema.is(type) || type["type"] == null;
export function defineTypes<S extends Schema = any, R extends Schema = any>(
    target: typeof Schema,
    fields: {
        [property: string]: DefinitionType | DefinitionTypeOptions<S, R>
    },
    context: Context = target._context || globalContext
) {
    for (let fieldName in fields) {
        const field = fields[fieldName];
        if (isDefinitionType(field)) {
            type(field, context)(target.prototype, fieldName);
            continue;
        }
        type(field.type, context)(target.prototype, fieldName);
        if (field.filter) filter(field.filter)(target.prototype, fieldName)
        if (field.filterChildren) filterChildren(field.filter)(target.prototype, fieldName)
    }
    return target;
}