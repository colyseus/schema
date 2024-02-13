import { type, PrimitiveType, DefinitionType, TypeContext, Metadata } from "./annotations";
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
    @type("number") accessor extendsId: number;
    @type([ ReflectionField ]) accessor fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ]) accessor types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();
    @type("number") accessor rootType: number;

    static encode (instance: Schema) {
        const context = new TypeContext(instance.constructor as typeof Schema);

        const reflection = new Reflection();
        const encoder = new Encoder(reflection);

        const buildType = (currentType: ReflectionType, metadata: any) => {
            for (const fieldName in metadata) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                const _type = Metadata.getType(metadata, fieldName);

                if (typeof (_type) === "string") {
                    fieldType = _type;

                } else {
                    let childTypeSchema: typeof Schema;

                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(_type)) {
                        fieldType = "ref";
                        childTypeSchema = _type as typeof Schema;

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
            const klass = context.types[typeid];
            const type = new ReflectionType();
            type.id = Number(typeid);

            // support inheritance
            const inheritFrom = Object.getPrototypeOf(klass);
            if (inheritFrom !== Schema) {
                type.extendsId = context.schemas.get(inheritFrom);
            }

            buildType(type, Metadata.getFor(klass));
        }

        return encoder.encodeAll();
    }

    static decode<T extends Schema = Schema>(bytes: number[], it?: Iterator): T {
        const reflection = new Reflection();

        const reflectionDecoder = new Decoder(reflection);
        reflectionDecoder.decode(bytes, it);

        const context = new TypeContext();

        const schemaTypes = reflection.types.reduce((types, reflectionType) => {
            const parentKlass: typeof Schema = types[reflectionType.extendsId] || Schema;
            const schema: typeof Schema = class _ extends parentKlass {};

            // const _metadata = Object.create(_classSuper[Symbol.metadata] ?? null);
            // TODO: support inheritance
            const _metadata = parentKlass && parentKlass[Symbol.metadata] || Object.create(null);
            Object.defineProperty(schema, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata })

            const typeid = reflectionType.id;
            types[typeid] = schema
            context.add(schema, typeid);
            return types;
        }, {});

        reflection.types.forEach((reflectionType) => {
            const schemaType = schemaTypes[reflectionType.id];
            const metadata = schemaType[Symbol.metadata];

            reflectionType.fields.forEach((field) => {
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
                        Metadata.addField(metadata, field.name, refType);
                        // type(refType)(schemaType.prototype, field.name);

                    } else {
                        Metadata.addField(metadata, field.name, { [fieldType]: refType } as DefinitionType);
                        // type({ [fieldType]: refType } as DefinitionType)(schemaType.prototype, field.name);
                    }

                } else {
                    console.log("Metadata.addField =>", field.name, field.type)
                    Metadata.addField(metadata, field.name, field.type as PrimitiveType);
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