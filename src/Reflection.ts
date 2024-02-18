import { type, PrimitiveType, DefinitionType, TypeContext } from "./annotations";
import { Metadata } from "./Metadata";
import { Schema } from "./Schema";
import { ArraySchema } from "./types/ArraySchema";
import { Iterator } from "./encoding/decode";
import { Encoder } from "./Encoder";
import { Decoder } from "./Decoder";

import * as util from "util";

/**
 * Reflection
 */
export class ReflectionField extends Schema {
    @type("string") name: string;
    @type("string") type: string;
    @type("number") referencedType: number;
}

export class ReflectionType extends Schema {
    @type("number") id: number;
    @type("number") extendsId: number;
    @type([ ReflectionField ]) fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ]) types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();
    @type("number") rootType: number;

    static encode (instance: Schema, context?: TypeContext) {
        if (!context) {
            context = new TypeContext(instance.constructor as typeof Schema);
        }

        const reflection = new Reflection();
        const encoder =  new Encoder(reflection);

        const buildType = (currentType: ReflectionType, metadata: any) => {
            for (const fieldName in metadata) {
                // skip fields from parent classes
                if (!Object.prototype.hasOwnProperty.call(metadata, fieldName)) {
                    continue;
                }

                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                const type = Metadata.getType(metadata, fieldName);

                if (typeof (type) === "string") {
                    fieldType = type;

                } else {
                    let childTypeSchema: typeof Schema;

                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(type)) {
                        fieldType = "ref";
                        childTypeSchema = type as typeof Schema;

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

            buildType(type, klass[Symbol.metadata]);
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
            const _metadata = parentKlass && parentKlass[Symbol.metadata] || Object.create(null);
            Object.defineProperty(schema, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata })

            // register for inheritance support
            TypeContext.register(schema);

            const typeid = reflectionType.id;
            types[typeid] = schema
            context.add(schema, typeid);
            return types;
        }, {});

        reflection.types.forEach((reflectionType) => {
            const schemaType = schemaTypes[reflectionType.id];
            const metadata = schemaType[Symbol.metadata];

            const parentKlass = reflection.types[reflectionType.extendsId];
            const parentFieldIndex = parentKlass && parentKlass.fields.length || 0;

            reflectionType.fields.forEach((field, i) => {
                const fieldIndex = parentFieldIndex + i;

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
                        // type(refType)(schemaType.prototype, field.name);
                        Metadata.addField(metadata, fieldIndex, field.name, refType);

                    } else {
                        // type({ [fieldType]: refType } as DefinitionType)(schemaType.prototype, field.name);
                        Metadata.addField(metadata, fieldIndex, field.name, { [fieldType]: refType } as DefinitionType);
                    }

                } else {
                    // type(field.type as PrimitiveType)(schemaType.prototype, field.name);
                    Metadata.addField(metadata, fieldIndex, field.name, field.type as PrimitiveType);
                }
            });
        });

        return new (schemaTypes[0])();
    }
}