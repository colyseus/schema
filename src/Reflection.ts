import { type, PrimitiveType, DefinitionType, TypeContext } from "./annotations";
import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { getType } from "./types/typeRegistry";
import { Iterator } from "./encoding/decode";
import { Encoder } from "./Encoder";
import { Decoder } from "./Decoder";

/**
 * Reflection
 */
export class ReflectionField extends Schema {
    @type("string")
    name: string;

    @type("string")
    type: string;

    @type("number")
    referencedType: number;
}

export class ReflectionType extends Schema {
    @type("number")
    id: number;

    @type([ ReflectionField ])
    fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ])
    types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();

    @type("number")
    rootType: number;

    static encode (instance: Schema) {
        const reflection = new Reflection();
        const encoder = new Encoder(reflection);

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

                    } else {
                        fieldType = Object.keys(type)[0];

                        if (typeof(type[fieldType]) === "string") {
                            fieldType += ":" + type[fieldType]; // array:string

                        } else {
                            childTypeSchema = type[fieldType];
                        }
                    }

                    field.referencedType = (childTypeSchema)
                        ? encoder.context.getTypeId(childTypeSchema)
                        : -1;
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        const context = new TypeContext(instance.constructor as typeof Schema);
        for (let typeid in context.types) {
            const type = new ReflectionType();
            type.id = Number(typeid);
            buildType(type, context.types[typeid]._definition.schema);
        }

        return encoder.encodeAll();
    }

    static decode<T extends Schema = Schema>(bytes: number[], it?: Iterator): T {
        const reflection = new Reflection();

        const reflectionDecoder = new Decoder(reflection)
        reflectionDecoder.decode(bytes, it);

        const context = new TypeContext();

        const schemaTypes = reflection.types.reduce((types, reflectionType) => {
            const schema: typeof Schema = class _ extends Schema {};
            const typeid = reflectionType.id;
            types[typeid] = schema
            context.add(schema, typeid);
            return types;
        }, {});

        reflection.types.forEach((reflectionType) => {
            const schemaType = schemaTypes[reflectionType.id];

            reflectionType.fields.forEach(field => {
                if (field.referencedType !== undefined) {
                    let fieldType = field.type;
                    let refType = schemaTypes[field.referencedType];

                    // map or array of primitive type (-1)
                    if (!refType) {
                        const typeInfo = field.type.split(":");
                        fieldType = typeInfo[0];
                        refType = typeInfo[1];
                    }

                    if (fieldType === "ref") {
                        type(refType)(schemaType.prototype, field.name);

                    } else {
                        type({ [fieldType]: refType } as DefinitionType)(schemaType.prototype, field.name);
                    }

                } else {
                    type(field.type as PrimitiveType)(schemaType.prototype, field.name);
                }
            });
        });

        return new (schemaTypes[0])();

        // /**
        //  * auto-initialize referenced types on root type
        //  * to allow registering listeners immediatelly on client-side
        //  */
        // for (let fieldName in rootType._definition.schema) {
        //     const fieldType = rootType._definition.schema[fieldName];

        //     if (typeof(fieldType) !== "string") {
        //         rootInstance[fieldName] = (typeof (fieldType) === "function")
        //             ? new (fieldType as any)() // is a schema reference
        //             : new (getType(Object.keys(fieldType)[0])).constructor(); // is a "collection"
        //     }
        // }
    }
}