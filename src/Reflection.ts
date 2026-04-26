import { PrimitiveType, schema, SchemaType } from "./annotations.js";
import { TypeContext } from "./types/TypeContext.js";
import { Metadata } from "./Metadata.js";
import { Iterator } from "./encoding/decode.js";
import { Encoder } from "./encoder/Encoder.js";
import { Decoder } from "./decoder/Decoder.js";
import { Schema } from "./Schema.js";
import { t, FieldBuilder } from "./types/builder.js";
import { ArraySchema } from "./types/custom/ArraySchema.js";
import { buildBitfieldLayout, createBitfieldClass, isBitfieldType } from "./types/custom/BitfieldValue.js";

/**
 * Static methods available on Reflection
 */
interface ReflectionStatic {
    /**
     * Encodes the TypeContext of an Encoder into a buffer.
     *
     * @param encoder Encoder instance
     * @param it
     * @returns
     */
    encode: (encoder: Encoder, it?: Iterator) => Uint8Array;

    /**
     * Decodes the TypeContext from a buffer into a Decoder instance.
     *
     * @param bytes Reflection.encode() output
     * @param it
     * @returns Decoder instance
     */
    decode: <T extends Schema = Schema>(bytes: Uint8Array, it?: Iterator) => Decoder<T>;
}

/**
 * Reflection
 */
export const ReflectionBitfieldSubField = schema({
    name: t.string(),
    width: t.uint8(),       // 1..32
    kind: t.uint8(),        // 0 = bool, 1 = uint
}, "ReflectionBitfieldSubField");
export type ReflectionBitfieldSubField = SchemaType<typeof ReflectionBitfieldSubField>;

export const ReflectionField = schema({
    name: t.string(),
    type: t.string(),
    referencedType: t.number(),
    /**
     * Sub-field layout for `t.bitfield(...)` fields. Undefined for all
     * other field types. Carries the ordered list of sub-fields with their
     * widths and kinds so reflection-decoded clients can reconstruct the
     * bit layout.
     */
    bitfield: t.array(ReflectionBitfieldSubField).optional(),
}, "ReflectionField");
export type ReflectionField = SchemaType<typeof ReflectionField>;

export const ReflectionType = schema({
    id: t.number(),
    extendsId: t.number(),
    fields: t.array(ReflectionField),
}, "ReflectionType");
export type ReflectionType = SchemaType<typeof ReflectionType>;

export const Reflection = schema({
    types: t.array(ReflectionType),
    rootType: t.number(),
}, "Reflection") as ReturnType<typeof schema<{
    types: FieldBuilder<ArraySchema<ReflectionType>, true, false>;
    rootType: FieldBuilder<number, false, false>;
}>> & ReflectionStatic;

export type Reflection = SchemaType<typeof Reflection>;

Reflection.encode = function (encoder: Encoder, it: Iterator = { offset: 0 }) {
    const context = encoder.context;

    const reflection = new Reflection();
    const reflectionEncoder = new Encoder(reflection);

    // rootType is usually the first schema passed to the Encoder
    // (unless it inherits from another schema)
    const rootType = context.schemas.get(encoder.state.constructor);
    if (rootType > 0) { reflection.rootType = rootType; }

    const includedTypeIds = new Set<number>();
    const pendingReflectionTypes: { [typeid: number]: ReflectionType[] } = {};

    // add type to reflection in a way that respects inheritance
    // (parent types should be added before their children)
    const addType = (type: ReflectionType) => {
        if (type.extendsId === undefined || includedTypeIds.has(type.extendsId)) {
            includedTypeIds.add(type.id);

            reflection.types.push(type);

            const deps = pendingReflectionTypes[type.id];
            if (deps !== undefined) {
                delete pendingReflectionTypes[type.id];
                deps.forEach((childType) => addType(childType));
            }
        } else {
            if (pendingReflectionTypes[type.extendsId] === undefined) {
                pendingReflectionTypes[type.extendsId] = [];
            }
            pendingReflectionTypes[type.extendsId].push(type);
        }
    };

    context.schemas.forEach((typeid, klass) => {
        const type = new ReflectionType();
        type.id = Number(typeid);

        // support inheritance
        const inheritFrom = Object.getPrototypeOf(klass);
        if (inheritFrom !== Schema) {
            type.extendsId = context.schemas.get(inheritFrom);
        }

        const metadata = klass[Symbol.metadata];

        //
        // FIXME: this is a workaround for inherited types without additional fields
        // if metadata is the same reference as the parent class - it means the class has no own metadata
        //
        if (metadata !== inheritFrom[Symbol.metadata]) {
            for (const fieldIndex in metadata) {
                const index = Number(fieldIndex);
                const fieldName = metadata[index].name;

                // skip fields from parent classes
                if (!Object.prototype.hasOwnProperty.call(metadata, fieldName)) {
                    continue;
                }

                const reflectionField = new ReflectionField();
                reflectionField.name = fieldName;

                let fieldType: string;

                const field = metadata[index];

                if (typeof (field.type) === "string") {
                    fieldType = field.type;

                } else if (isBitfieldType(field.type)) {
                    // Serialize sub-field layout so reflection-decoded
                    // clients can reconstruct the bit packing.
                    fieldType = "bitfield";
                    const layout = field.type.bitfield;
                    const subFields = new ArraySchema<typeof ReflectionBitfieldSubField extends new (...a: any) => infer R ? R : never>();
                    for (let i = 0; i < layout.fields.length; i++) {
                        const f = layout.fields[i];
                        const sub = new ReflectionBitfieldSubField();
                        sub.name = f.name;
                        sub.width = f.width;
                        sub.kind = f.kind === "bool" ? 0 : 1;
                        subFields.push(sub);
                    }
                    reflectionField.bitfield = subFields;

                } else {
                    let childTypeSchema: typeof Schema;

                    //
                    // TODO: refactor below.
                    //
                    if (Schema.is(field.type)) {
                        fieldType = "ref";
                        childTypeSchema = field.type as typeof Schema;

                    } else {
                        fieldType = Object.keys(field.type)[0];

                        if (typeof (field.type[fieldType as keyof typeof field.type]) === "string") {
                            fieldType += ":" + field.type[fieldType as keyof typeof field.type]; // array:string

                        } else {
                            childTypeSchema = field.type[fieldType as keyof typeof field.type];
                        }
                    }

                    reflectionField.referencedType = (childTypeSchema)
                        ? context.getTypeId(childTypeSchema)
                        : -1;
                }

                reflectionField.type = fieldType;
                type.fields.push(reflectionField);
            }
        }

        addType(type);
    });

    // in case there are types that were not added due to inheritance
    for (const typeid in pendingReflectionTypes) {
        pendingReflectionTypes[typeid].forEach((type) =>
            reflection.types.push(type))
    }

    const buf = reflectionEncoder.encodeAll(it);
    return buf.slice(0, it.offset);
};

Reflection.decode = function <T extends Schema = Schema>(bytes: Uint8Array, it?: Iterator): Decoder<T> {
    const reflection = new Reflection();

    const reflectionDecoder = new Decoder(reflection);
    reflectionDecoder.decode(bytes, it);

    const typeContext = new TypeContext();

    // 1st pass, initialize metadata + inheritance
    reflection.types.forEach((reflectionType) => {
        const parentClass: typeof Schema = typeContext.get(reflectionType.extendsId) ?? Schema;
        const schema: typeof Schema = class _ extends parentClass { };

        // register for inheritance support
        TypeContext.register(schema);

        typeContext.add(schema, reflectionType.id);
    }, {});

    // define fields
    const addFields = (metadata: Metadata, reflectionType: ReflectionType, parentFieldIndex: number) => {
        reflectionType.fields.forEach((field, i) => {
            const fieldIndex = parentFieldIndex + i;

            if (field.bitfield !== undefined && field.bitfield.length > 0) {
                // Reconstruct a bitfield layout from the wire-shipped sub-field list.
                const spec: { [name: string]: { kind: "bool" | "uint"; bits?: number } } = {};
                for (let j = 0; j < field.bitfield.length; j++) {
                    const sub = field.bitfield[j];
                    spec[sub.name] = sub.kind === 0
                        ? { kind: "bool" }
                        : { kind: "uint", bits: sub.width };
                }
                const layout = buildBitfieldLayout(spec);
                createBitfieldClass(layout);
                Metadata.addField(metadata, fieldIndex, field.name, { bitfield: layout } as any);

            } else if (field.referencedType !== undefined) {
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