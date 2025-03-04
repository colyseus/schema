import { DefinitionType, getPropertyDescriptor } from "./annotations";
import { Schema } from "./Schema";
import { getType } from "./types/registry";
import { $decoder, $descriptors, $encoder, $fieldIndexesByViewTag, $numFields, $refTypeFieldIndexes, $track, $viewFieldIndexes } from "./types/symbols";
import { TypeContext } from "./types/TypeContext";

export type MetadataField = {
    type: DefinitionType,
    name: string,
    index: number,
    tag?: number,
    unreliable?: boolean,
    deprecated?: boolean,
};

export type Metadata =
    { [$numFields]: number; } & // number of fields
    { [$viewFieldIndexes]: number[]; } & // all field indexes with "view" tag
    { [$fieldIndexesByViewTag]: {[tag: number]: number[]}; } & // field indexes by "view" tag
    { [$refTypeFieldIndexes]: number[]; } & // all field indexes containing Ref types (Schema, ArraySchema, MapSchema, etc)
    { [field: number]: MetadataField; } & // index => field name
    { [field: string]: number; } & // field name => field metadata
    { [$descriptors]: { [field: string]: PropertyDescriptor } }  // property descriptors

export function getNormalizedType(type: DefinitionType): DefinitionType  {
    return (Array.isArray(type))
        ? { array: type[0] }
        : (typeof(type['type']) !== "undefined")
            ? type['type']
            : type;
}

// TODO: see test: "should support TypeScript enums"
function isTSEnum(_enum: any) {
    const keys = Object.keys(_enum);
    const numericFields = keys.filter(k => /\d+/.test(k));
    return (numericFields.length === (keys.length / 2) && _enum[_enum[numericFields[0]]] == numericFields[0]);
}

export const Metadata = {

    addField(metadata: any, index: number, name: string, type: DefinitionType, descriptor?: PropertyDescriptor) {
        if (index > 64) {
            throw new Error(`Can't define field '${name}'.\nSchema instances may only have up to 64 fields.`);
        }

        metadata[index] = Object.assign(
            metadata[index] || {}, // avoid overwriting previous field metadata (@owned / @deprecated)
            {
                type: getNormalizedType(type),
                index,
                name,
            }
        );

        // create "descriptors" map
        Object.defineProperty(metadata, $descriptors, {
            value: metadata[$descriptors] || {},
            enumerable: false,
            configurable: true,
        });

        if (descriptor) {
            // for encoder
            metadata[$descriptors][name] = descriptor;
            metadata[$descriptors][`_${name}`] = {
                value: undefined,
                writable: true,
                enumerable: false,
                configurable: true,
            };
        } else {
            // for decoder
            metadata[$descriptors][name] = {
                value: undefined,
                writable: true,
                enumerable: true,
                configurable: true,
            };
        }

        // map -1 as last field index
        Object.defineProperty(metadata, $numFields, {
            value: index,
            enumerable: false,
            configurable: true
        });

        // map field name => index (non enumerable)
        Object.defineProperty(metadata, name, {
            value: index,
            enumerable: false,
            configurable: true,
        });

        // if child Ref/complex type, add to -4
        if (typeof (metadata[index].type) !== "string") {
            if (metadata[$refTypeFieldIndexes] === undefined) {
                Object.defineProperty(metadata, $refTypeFieldIndexes, {
                    value: [],
                    enumerable: false,
                    configurable: true,
                });
            }
            metadata[$refTypeFieldIndexes].push(index);
        }
    },

    setTag(metadata: Metadata, fieldName: string, tag: number) {
        const index = metadata[fieldName];
        const field = metadata[index];

        // add 'tag' to the field
        field.tag = tag;

        if (!metadata[$viewFieldIndexes]) {
            // -2: all field indexes with "view" tag
            Object.defineProperty(metadata, $viewFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true
            });

            // -3: field indexes by "view" tag
            Object.defineProperty(metadata, $fieldIndexesByViewTag, {
                value: {},
                enumerable: false,
                configurable: true
            });
        }

        metadata[$viewFieldIndexes].push(index);

        if (!metadata[$fieldIndexesByViewTag][tag]) {
            metadata[$fieldIndexesByViewTag][tag] = [];
        }

        metadata[$fieldIndexesByViewTag][tag].push(index);
    },

    setFields<T extends { new (...args: any[]): InstanceType<T> } = any>(target: T, fields: { [field in keyof InstanceType<T>]?: DefinitionType }) {
        // for inheritance support
        const constructor = target.prototype.constructor;
        TypeContext.register(constructor);

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass && parentClass[Symbol.metadata];
        const metadata = Metadata.initialize(constructor);

        // Use Schema's methods if not defined in the class
        if (!constructor[$track]) { constructor[$track] = Schema[$track]; }
        if (!constructor[$encoder]) { constructor[$encoder] = Schema[$encoder]; }
        if (!constructor[$decoder]) { constructor[$decoder] = Schema[$decoder]; }
        if (!constructor.prototype.toJSON) { constructor.prototype.toJSON = Schema.prototype.toJSON; }

        //
        // detect index for this field, considering inheritance
        //
        let fieldIndex = metadata[$numFields] // current structure already has fields defined
            ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
            ?? -1; // no fields defined

        fieldIndex++;

        for (const field in fields) {
            const type = fields[field];

            // FIXME: this code is duplicated from @type() annotation
            const complexTypeKlass = (Array.isArray(type))
                ? getType("array")
                : (typeof(Object.keys(type)[0]) === "string") && getType(Object.keys(type)[0]);

            const childType = (complexTypeKlass)
                ? Object.values(type)[0]
                : getNormalizedType(type);

            Metadata.addField(
                metadata,
                fieldIndex,
                field,
                type,
                getPropertyDescriptor(`_${field}`, fieldIndex, childType, complexTypeKlass)
            );

            fieldIndex++;
        }

        return target;
    },

    isDeprecated(metadata: any, field: string) {
        return metadata[field].deprecated === true;
    },

    init(klass: any) {
        //
        // Used only to initialize an empty Schema (Encoder#constructor)
        // TODO: remove/refactor this...
        //
        const metadata = {};
        klass[Symbol.metadata] = metadata;
        Object.defineProperty(metadata, $numFields, {
            value: 0,
            enumerable: false,
            configurable: true,
        });
    },

    initialize(constructor: any) {
        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata: Metadata = parentClass[Symbol.metadata];

        let metadata: Metadata = constructor[Symbol.metadata] ?? Object.create(null);

        // make sure inherited classes have their own metadata object.
        if (parentClass !== Schema && metadata === parentMetadata) {
            metadata = Object.create(null);

            if (parentMetadata) {
                //
                // assign parent metadata to current
                //
                Object.setPrototypeOf(metadata, parentMetadata);

                // $numFields
                Object.defineProperty(metadata, $numFields, {
                    value: parentMetadata[$numFields],
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });

                // $viewFieldIndexes / $fieldIndexesByViewTag
                if (parentMetadata[$viewFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $viewFieldIndexes, {
                        value: [...parentMetadata[$viewFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                    Object.defineProperty(metadata, $fieldIndexesByViewTag, {
                        value: { ...parentMetadata[$fieldIndexesByViewTag] },
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $refTypeFieldIndexes
                if (parentMetadata[$refTypeFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $refTypeFieldIndexes, {
                        value: [...parentMetadata[$refTypeFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $descriptors
                Object.defineProperty(metadata, $descriptors, {
                    value: { ...parentMetadata[$descriptors] },
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            }
        }

        constructor[Symbol.metadata] = metadata;

        return metadata;
    },

    isValidInstance(klass: any) {
        return (
            klass.constructor[Symbol.metadata] &&
            Object.prototype.hasOwnProperty.call(klass.constructor[Symbol.metadata], $numFields) as boolean
        );
    },

    getFields(klass: any) {
        const metadata: Metadata = klass[Symbol.metadata];
        const fields = {};
        for (let i = 0; i <= metadata[$numFields]; i++) {
            fields[metadata[i].name] = metadata[i].type;
        }
        return fields;
    }
}