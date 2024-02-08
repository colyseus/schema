import { type, PrimitiveType, DefinitionType, TypeContext, SchemaDefinition } from "./annotations";
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
    @type("string") accessor name: string;
    @type("string") accessor type: string;
    @type("number") accessor referencedType: number;
}

export class ReflectionType extends Schema {
    @type("number") accessor id: number;
    @type([ ReflectionField ]) accessor fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ]) accessor types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();
    @type("number") accessor rootType: number;

    static encode (instance: Schema) {
        const context = new TypeContext(instance.constructor as typeof Schema);

        const reflection = new Reflection();
        const encoder = new Encoder(reflection);

        const buildType = (currentType: ReflectionType, definition: SchemaDefinition) => {
            const schema = definition.schema;
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName] as string;

                } else {
                    const type = schema[fieldName];
                    let childTypeSchema: typeof Schema;

                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(type)) {
                        fieldType = "ref";
                        childTypeSchema = schema[fieldName] as typeof Schema;

                    } else {
                        fieldType = Object.keys(type)[0];

                        if (typeof(type[fieldType]) === "string") {
                            fieldType += ":" + type[fieldType]; // array:string

                        } else {
                            childTypeSchema = type[fieldType];
                        }
                    }

                    field.referencedType = (childTypeSchema)
                        ? context.getTypeId(childTypeSchema)
                        : -1;
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        for (let typeid in context.types) {
            const type = new ReflectionType();
            type.id = Number(typeid);
            buildType(type, context.types[typeid][Symbol.metadata]['def']);
        }

        return encoder.encodeAll();
    }

    static decode<T extends Schema = Schema>(bytes: number[], it?: Iterator): T {
        const reflection = new Reflection();

        const reflectionDecoder = new Decoder(reflection);
        reflectionDecoder.decode(bytes, it);

        const context = new TypeContext();

        const schemaTypes = reflection.types.reduce((types, reflectionType) => {
            const schema: typeof Schema = class _ extends Schema {};
            schema[Symbol.metadata] = { def: SchemaDefinition.create() };

            const typeid = reflectionType.id;
            types[typeid] = schema
            context.add(schema, typeid);
            return types;
        }, {});

        reflection.types.forEach((reflectionType) => {
            const schemaType = schemaTypes[reflectionType.id];
            const def = schemaType[Symbol.metadata]['def'] as SchemaDefinition;

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
                        def.addField(field.name, refType);
                        // type(refType)(schemaType.prototype, field.name);

                    } else {
                        def.addField(field.name, { [fieldType]: refType } as DefinitionType);
                        // type({ [fieldType]: refType } as DefinitionType)(schemaType.prototype, field.name);
                    }

                } else {
                    def.addField(field.name, field.type as PrimitiveType);
                    // type(field.type as PrimitiveType)(schemaType.prototype, field.name);
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