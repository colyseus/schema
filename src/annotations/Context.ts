import { DefinitionType, SchemaDefinition, type } from '.';
import { Schema } from '../Schema';

// Colyseus integration
export type ClientWithSessionId = { sessionId: string } & any;

export class Context {
    types: {[id: number]: typeof Schema} = {};
    schemas = new Map<typeof Schema, number>();
    useFilters = false;

    has(schema: typeof Schema) {
        return this.schemas.has(schema);
    }

    get(typeid: number) {
        return this.types[typeid];
    }

    add(schema: typeof Schema, typeid: number = this.schemas.size) {
        // FIXME: move this to somewhere else?
        // support inheritance
        schema._definition = SchemaDefinition.create(schema._definition);

        schema._typeid = typeid;
        this.types[typeid] = schema;
        this.schemas.set(schema, typeid);
    }

    static create(context: Context = new Context) {
        return function (definition: DefinitionType) {
            return type(definition, context);
        }
    }
}

export const globalContext = new Context();