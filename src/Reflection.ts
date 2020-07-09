import { type, PrimitiveType, Context } from "./annotations";
import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";
import { CollectionSchema } from "./types/CollectionSchema";
import { SetSchema } from "./types/SetSchema";
import * as decode from "./encoding/decode";

const reflectionContext = new Context();

/**
 * Reflection
 */
export class ReflectionField extends Schema {
    @type("string", reflectionContext)
    name: string;

    @type("string", reflectionContext)
    type: string;

    @type("uint8", reflectionContext)
    referencedType: number;
}

export class ReflectionType extends Schema {
    @type("uint8", reflectionContext)
    id: number;

    @type([ ReflectionField ], reflectionContext)
    fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ], reflectionContext)
    types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();

    @type("uint8", reflectionContext)
    rootType: number;

    static encode (instance: Schema) {
        const rootSchemaType = instance.constructor as typeof Schema;

        const reflection = new Reflection();
        reflection.rootType = rootSchemaType._typeid;

        const buildType = (currentType: ReflectionType, schema: any) => {
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName];

                } else {
                    const type = schema[fieldName];
                    let childTypeSchema: typeof Schema;

                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(type)) {
                        fieldType = "ref";
                        childTypeSchema = schema[fieldName];

                    } else if (ArraySchema.is(type)) {
                        fieldType = "array";

                        if (typeof(schema[fieldName][0]) === "string") {
                            fieldType += ":" + schema[fieldName][0]; // array:string

                        } else {
                            childTypeSchema = schema[fieldName][0];
                        }

                    } else if (MapSchema.is(type)) {
                        fieldType = "map";

                        if (typeof(schema[fieldName].map) === "string") {
                            fieldType += ":" + schema[fieldName].map; // array:string

                        } else {
                            childTypeSchema = schema[fieldName].map;
                        }

                    } else if (CollectionSchema.is(type)) {
                        fieldType = "collection";

                        if (typeof(schema[fieldName].collection) === "string") {
                            fieldType += ":" + schema[fieldName].collection; // collection:string

                        } else {
                            childTypeSchema = schema[fieldName].collection;
                        }

                    } else if (SetSchema.is(type)) {
                        fieldType = "set";

                        if (typeof(schema[fieldName].set) === "string") {
                            fieldType += ":" + schema[fieldName].set; // set:string

                        } else {
                            childTypeSchema = schema[fieldName].set;
                        }
                    }

                    field.referencedType = (childTypeSchema)
                        ? childTypeSchema._typeid
                        : 255;
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        const types = rootSchemaType._context.types;
        for (let typeid in types) {
            const type = new ReflectionType();
            type.id = Number(typeid);
            buildType(type, types[typeid]._definition.schema);
        }

        return reflection.encodeAll();
    }

    static decode (bytes: number[], it?: decode.Iterator): Schema {
        const context = new Context();

        const reflection = new Reflection();
        reflection.decode(bytes, it);

        let schemaTypes = reflection.types.reduce((types, reflectionType) => {
            types[reflectionType.id] = class _ extends Schema {};
            return types;
        }, {});

        reflection.types.forEach((reflectionType, i) => {
            reflectionType.fields.forEach(field => {
                const schemaType = schemaTypes[reflectionType.id];

                if (field.referencedType !== undefined) {
                    let refType = schemaTypes[field.referencedType];

                    // map or array of primitive type (255)
                    if (!refType) {
                        refType = field.type.split(":")[1];
                    }

                    if (field.type.indexOf("array") === 0) {
                        type([ refType ], context)(schemaType.prototype, field.name);

                    } else if (field.type.indexOf("map") === 0) {
                        type({ map: refType }, context)(schemaType.prototype, field.name);

                    } else if (field.type.indexOf("collection") === 0) {
                        type({ collection: refType }, context)(schemaType.prototype, field.name);

                    } else if (field.type.indexOf("set") === 0) {
                        type({ set: refType }, context)(schemaType.prototype, field.name);

                    } else if (field.type === "ref") {
                        type(refType, context)(schemaType.prototype, field.name);

                    }

                } else {
                    type(field.type as PrimitiveType, context)(schemaType.prototype, field.name);
                }
            });
        })

        const rootType: any = schemaTypes[reflection.rootType];
        const rootInstance = new rootType();

        /**
         * auto-initialize referenced types on root type
         * to allow registering listeners immediatelly on client-side
         */
        for (let fieldName in rootType._definition.schema) {
            const fieldType = rootType._definition.schema[fieldName];

            if (typeof(fieldType) !== "string") {
                const isSchema = typeof (fieldType) === "function";
                const isArray = Array.isArray(fieldType);
                const isMap = !isArray && (fieldType as any).map;

                rootInstance[fieldName] = (isArray)
                    ? new ArraySchema()
                    : (isMap)
                        ? new MapSchema()
                        : (isSchema)
                            ? new (fieldType as any)()
                            : undefined;
            }
        }

        return rootInstance;
    }
}