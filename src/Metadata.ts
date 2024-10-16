import { getPropertyDescriptor, type DefinitionType } from "./annotations";
import { getType } from "./types/registry";
import { $descriptors } from "./types/symbols";

export type MetadataField = {
    type: DefinitionType,
    name: string,
    index: number,
    tag?: number,
    unreliable?: boolean,
    deprecated?: boolean,
};

export type Metadata =
    { ["$_numFields"]: number; } & // number of fields
    { ["$_viewFieldIndexes"]: number[]; } & // all field indexes with "view" tag
    { ["$_fieldIndexesByViewTag"]: {[tag: number]: number[]}; } & // field indexes by "view" tag
    { ["$_refTypeFieldIndexes"]: number[]; } & // all field indexes containing Ref types (Schema, ArraySchema, MapSchema, etc)
    { [field: number]: MetadataField; } & // index => field name
    { [field: string]: number; } & // field name => field metadata
    { [$descriptors]: { [field: string]: PropertyDescriptor } }  // property descriptors

export const Metadata = {

    addField(metadata: any, index: number, name: string, type: DefinitionType, descriptor?: PropertyDescriptor) {
        if (index > 64) {
            throw new Error(`Can't define field '${name}'.\nSchema instances may only have up to 64 fields.`);
        }

        metadata[index] = Object.assign(
            metadata[index] || {}, // avoid overwriting previous field metadata (@owned / @deprecated)
            {
                type: (Array.isArray(type))
                    ? { array: type[0] }
                    : type,
                index,
                name,
            }
        );

        // create "descriptors" map
        metadata[$descriptors] ??= {};

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
        Object.defineProperty(metadata, "$_numFields", {
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
            if (metadata["$_refTypeFieldIndexes"] === undefined) {
                Object.defineProperty(metadata, "$_refTypeFieldIndexes", {
                    value: [],
                    enumerable: false,
                    configurable: true,
                });
            }
            metadata["$_refTypeFieldIndexes"].push(index);
        }
    },

    setTag(metadata: Metadata, fieldName: string, tag: number) {
        const index = metadata[fieldName];
        const field = metadata[index];

        // add 'tag' to the field
        field.tag = tag;

        if (!metadata["$_viewFieldIndexes"]) {
            // -2: all field indexes with "view" tag
            Object.defineProperty(metadata, "$_viewFieldIndexes", {
                value: [],
                enumerable: false,
                configurable: true
            });

            // -3: field indexes by "view" tag
            Object.defineProperty(metadata, "$_fieldIndexesByViewTag", {
                value: {},
                enumerable: false,
                configurable: true
            });
        }

        metadata["$_viewFieldIndexes"].push(index);

        if (!metadata["$_fieldIndexesByViewTag"][tag]) {
            metadata["$_fieldIndexesByViewTag"][tag] = [];
        }

        metadata["$_fieldIndexesByViewTag"][tag].push(index);
    },

    setFields(target: any, fields: { [field: string]: DefinitionType }) {
        const metadata = (target.prototype.constructor[Symbol.metadata] ??= {});

        let index = 0;
        for (const field in fields) {
            const type = fields[field];

            // FIXME: this code is duplicated from @type() annotation
            const complexTypeKlass = (Array.isArray(type))
                ? getType("array")
                : (typeof(Object.keys(type)[0]) === "string") && getType(Object.keys(type)[0]);

            Metadata.addField(
                metadata,
                index,
                field,
                type,
                getPropertyDescriptor(`_${field}`, index, type, complexTypeKlass)
            );

            index++;
        }
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
        Object.defineProperty(metadata, "$_numFields", {
            value: 0,
            enumerable: false,
            configurable: true,
        });
    },

    initialize(constructor: any, parentMetadata?: Metadata) {
        let metadata: Metadata = constructor[Symbol.metadata] ?? Object.create(null);

        // make sure inherited classes have their own metadata object.
        if (constructor[Symbol.metadata] === parentMetadata) {
            metadata = Object.create(null);

            if (parentMetadata) {
                // assign parent metadata to current
                Object.assign(metadata, parentMetadata);

                for (let i = 0; i <= parentMetadata["$_numFields"]; i++) {
                    const fieldName = parentMetadata[i].name;
                    Object.defineProperty(metadata, fieldName, {
                        value: parentMetadata[fieldName],
                        enumerable: false,
                        configurable: true,
                    });
                }

                Object.defineProperty(metadata, "$_numFields", {
                    value: parentMetadata["$_numFields"],
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
            Object.prototype.hasOwnProperty.call(klass.constructor[Symbol.metadata], "$_numFields") as boolean
        );
    },

    getFields(klass: any) {
        const metadata: Metadata = klass[Symbol.metadata];
        const fields = {};
        for (let i = 0; i <= metadata["$_numFields"]; i++) {
            fields[metadata[i].name] = metadata[i].type;
        }
        return fields;
    }
}