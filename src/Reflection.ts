import { type, PrimitiveType, Context } from "./annotations";
import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

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

    static encode (instance: Schema) {
        const reflection = new Reflection();

        const rootSchemaType = instance.constructor as typeof Schema;
        const schema = rootSchemaType._schema

        const rootType = new ReflectionType();
        rootType.id = rootSchemaType._typeid;

        // const typeIds: {[id: string]: number} = {};

        const buildType = (currentType: ReflectionType, schema: any) => {
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName];

                } else {
                    const isSchema = typeof (schema[fieldName]) === "function";
                    const isArray = Array.isArray(schema[fieldName]);
                    const isMap = !isArray && (schema[fieldName] as any).map;

                    let childTypeSchema: typeof Schema;
                    if (isSchema) {
                        fieldType = "ref";
                        childTypeSchema = schema[fieldName];

                    } else if (isArray) {
                        fieldType = "array";

                        if (typeof(schema[fieldName][0]) === "string") {
                            fieldType += ":" + schema[fieldName][0]; // array:string

                        } else {
                            childTypeSchema = schema[fieldName][0];
                        }

                    } else if (isMap) {
                        fieldType = "map";

                        if (typeof(schema[fieldName].map) === "string") {
                            fieldType += ":" + schema[fieldName].map; // array:string

                        } else {
                            childTypeSchema = schema[fieldName].map;
                        }
                    }

                    if (childTypeSchema) {
                        // const childSchemaName = childTypeSchema.name;
                        // if (typeIds[childSchemaName] === undefined) {
                        //     const childType = new ReflectionType();
                        //     childType.id = childTypeSchema._typeid;
                        //     typeIds[childSchemaName] = childType.id;
                        //     buildType(childType, childTypeSchema._schema);
                        // }
                        // field.referencedType = typeIds[childSchemaName];

                        field.referencedType = childTypeSchema._typeid;

                    } else {
                        field.referencedType = 255;
                    }
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        buildType(rootType, schema);

        const types = rootSchemaType._context.types;
        for (let typeid in types) {
            if (types[typeid] !== rootSchemaType) {
                const childType = new ReflectionType();
                childType.id = Number(typeid);
                buildType(childType, types[typeid]._schema);
            }
        }

        return reflection.encodeAll();
    }

    static decode (bytes: number[]): Schema {
        const context = new Context();

        const reflection = new Reflection();
        reflection.decode(bytes);

        let rootTypeId: number;

        let schemaTypes = reflection.types.reduce((types, reflectionType) => {
            if (rootTypeId === undefined) {
                rootTypeId = reflectionType.id;
                console.log("ROOT TYPE ID:", rootTypeId);
            }

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

                    } else if (field.type === "ref") {
                        type(refType, context)(schemaType.prototype, field.name);

                    }

                } else {
                    type(field.type as PrimitiveType, context)(schemaType.prototype, field.name);
                }
            });
        })

        const rootType: any = schemaTypes[rootTypeId];
        const rootInstance = new rootType();

        /**
         * auto-initialize referenced types on root type
         * to allow registering listeners immediatelly on client-side
         */
        for (let fieldName in rootType._schema) {
            const fieldType = rootType._schema[fieldName];

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