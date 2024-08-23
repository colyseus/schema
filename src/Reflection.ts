import { type, PrimitiveType, DefinitionType } from "./annotations";
import { TypeContext } from "./types/TypeContext";
import { Metadata } from "./Metadata";
import { ArraySchema } from "./types/custom/ArraySchema";
import { Iterator } from "./encoding/decode";
import { Encoder } from "./encoder/Encoder";
import { Decoder } from "./decoder/Decoder";
import { Schema } from "./Schema";

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
    @type([ ReflectionField ]) fields = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ]) types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();

    static encode(instance: Schema, context?: TypeContext, it: Iterator = { offset: 0 }) {
        context ??= new TypeContext(instance.constructor as typeof Schema);

        const reflection = new Reflection();
        const encoder = new Encoder(reflection);

        const buildType = (currentType: ReflectionType, metadata: Metadata) => {
            for (const fieldIndex in metadata) {
                const index = Number(fieldIndex);
                const fieldName = metadata[index].name;

                // skip fields from parent classes
                if (!Object.prototype.hasOwnProperty.call(metadata, fieldName)) {
                    continue;
                }

                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                const type = metadata[index].type;

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

        const buf = encoder.encodeAll(it);
        return Buffer.from(buf, 0, it.offset);
    }

    static decode<T extends Schema = Schema>(bytes: Buffer, it?: Iterator): T {
        const reflection = new Reflection();

        const reflectionDecoder = new Decoder(reflection);
        reflectionDecoder.decode(bytes, it);

        const typeContext = new TypeContext();

        // 1st pass, initialize metadata + inheritance
        reflection.types.forEach((reflectionType) => {
            const parentClass: typeof Schema = typeContext.get(reflectionType.extendsId) ?? Schema;
            const schema: typeof Schema = class _ extends parentClass {};

            const parentMetadata = parentClass[Symbol.metadata];

            // register for inheritance support
            TypeContext.register(schema);

            // for inheritance support
            Metadata.initialize(schema, parentMetadata);

            typeContext.add(schema, reflectionType.id);
        }, {});

        // 2nd pass, set fields
        reflection.types.forEach((reflectionType) => {
            const schemaType = typeContext.get(reflectionType.id);
            const metadata = schemaType[Symbol.metadata];

            const parentFieldIndex = 0;

            reflectionType.fields.forEach((field, i) => {
                const fieldIndex = parentFieldIndex + i;

                if (field.referencedType !== undefined) {
                    let fieldType = field.type;
                    let refType: PrimitiveType = typeContext.get(field.referencedType);

                    // map or array of primitive type (-1)
                    if (!refType) {
                        const typeInfo = field.type.split(":");
                        fieldType = typeInfo[0];
                        refType = typeInfo[1] as PrimitiveType; // string
                    }

                    if (fieldType === "ref") {
                        Metadata.addField(metadata, fieldIndex, field.name, refType);

                    } else {
                        Metadata.addField(metadata, fieldIndex, field.name, { [fieldType]: refType } as DefinitionType);
                    }

                } else {
                    Metadata.addField(metadata, fieldIndex, field.name, field.type as PrimitiveType);
                }
            });
        });

        // @ts-ignore
        return new (typeContext.get(0))();
    }
}
