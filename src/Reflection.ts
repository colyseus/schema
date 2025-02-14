import { type, PrimitiveType } from "./annotations";
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
    @type([ReflectionType]) types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();
    @type("number") rootType: number;

    /**
     * Encodes the TypeContext of an Encoder into a buffer.
     *
     * @param encoder Encoder instance
     * @param it
     * @returns
     */
    static encode(encoder: Encoder, it: Iterator = { offset: 0 }) {
        const context = encoder.context;

        const reflection = new Reflection();
        const reflectionEncoder = new Encoder(reflection);

        // rootType is usually the first schema passed to the Encoder
        // (unless it inherits from another schema)
        const rootType = context.schemas.get(encoder.state.constructor);
        if (rootType > 0) { reflection.rootType = rootType; }

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

        const buf = reflectionEncoder.encodeAll(it);
        return Buffer.from(buf, 0, it.offset);
    }

    /**
     * Decodes the TypeContext from a buffer into a Decoder instance.
     *
     * @param bytes Reflection.encode() output
     * @param it
     * @returns Decoder instance
     */
    static decode<T extends Schema = Schema>(bytes: Buffer, it?: Iterator): Decoder<T> {
        const reflection = new Reflection();

        const reflectionDecoder = new Decoder(reflection);
        reflectionDecoder.decode(bytes, it);

        const typeContext = new TypeContext();

        // 1st pass, initialize metadata + inheritance
        reflection.types.forEach((reflectionType) => {
            const parentClass: typeof Schema = typeContext.get(reflectionType.extendsId) ?? Schema;
            const schema: typeof Schema = class _ extends parentClass {};

            // register for inheritance support
            TypeContext.register(schema);

            // // for inheritance support
            // Metadata.initialize(schema);

            typeContext.add(schema, reflectionType.id);
        }, {});

        // define fields
        const addFields = (metadata: Metadata, reflectionType: ReflectionType, parentFieldIndex: number) => {
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
                        Metadata.addField(metadata, fieldIndex, field.name, { [fieldType]: refType });
                    }

                } else {
                    Metadata.addField(metadata, fieldIndex, field.name, field.type as PrimitiveType);
                }
            });
        };

        // 2nd pass, set fields
        reflection.types.forEach((reflectionType) => {
            const schema = typeContext.get(reflectionType.id);

            // for inheritance support
            const metadata = Metadata.initialize(schema);

            const inheritedTypes: ReflectionType[] = [];

            let parentType: ReflectionType = reflectionType;
            do {
                inheritedTypes.push(parentType);
                parentType = reflection.types.find((t) => t.id === parentType.extendsId);
            } while (parentType);

            let parentFieldIndex = 0;

            inheritedTypes.reverse().forEach((reflectionType) => {
                // add fields from all inherited classes
                // TODO: refactor this to avoid adding fields from parent classes
                addFields(metadata, reflectionType, parentFieldIndex);
                parentFieldIndex += reflectionType.fields.length;
            });
        });

        const state: T = new (typeContext.get(reflection.rootType || 0) as unknown as any)();

        return new Decoder<T>(state, typeContext);
    }
}
