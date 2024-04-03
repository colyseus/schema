import { getPropertyDescriptor, type DefinitionType } from "./annotations";
import { getType } from "./types/registry";

export type MetadataField = {
    type: DefinitionType,
    index: number,
    owned?: boolean,
    unreliable?: boolean,
    deprecated?: boolean,
    descriptor?: PropertyDescriptor,
};

export type Metadata =
    { [-1]: number; } & // number of fields
    { [-2]: boolean; } & // has filters
    { [field: number]: string; } & // index => field name
    { [field: string]: MetadataField; } // field name => field metadata

export const Metadata = {

    addField(metadata: any, index: number, field: string, type: DefinitionType, descriptor?: PropertyDescriptor) {
        if (index > 64) {
            throw new Error(`Can't define field '${field}'.\nSchema instances may only have up to 64 fields.`);
        }

        metadata[field] = Object.assign(
            metadata[field] || {}, // avoid overwriting previous field metadata (@owned / @deprecated)
            {
                type: (Array.isArray(type))
                    ? { array: type[0] }
                    : type,
                index,
                descriptor,
            }
        );

        // map -1 as last field index
        Object.defineProperty(metadata, -1, {
            value: index,
            enumerable: false,
            configurable: true
        });

        // map index => field name (non enumerable)
        Object.defineProperty(metadata, index, {
            value: field,
            enumerable: false,
            configurable: true,
        });
    },

    setFields(target: any, fields: { [field: string]: DefinitionType }) {
        const metadata = (target.prototype.constructor[Symbol.metadata] ??= {});

        // target[$track] = function (changeTree, index: number, operation: OPERATION = OPERATION.ADD) {
        //     changeTree.change(index, operation, encodeSchemaOperation);
        // };

        // target[$encoder] = encodeSchemaOperation;
        // target[$decoder] = decodeSchemaOperation;

        // if (!target.prototype.toJSON) { target.prototype.toJSON = Schema.prototype.toJSON; }

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
                getPropertyDescriptor(`_${field}`, index, type, complexTypeKlass, metadata, field)
            );

            index++;
        }
    },

    isDeprecated(metadata: any, field: string) {
        return metadata[field].deprecated === true;
    },

    isValidInstance(klass: any) {
        return (
            klass.constructor[Symbol.metadata] &&
            Object.prototype.hasOwnProperty.call(klass.constructor[Symbol.metadata], -1) as boolean
        );
    },

    getFields(metadata: any) {
        const fields = {};
        for (let i = 0; i < metadata[-1]; i++) {
            fields[metadata[i]] = metadata[metadata[i]];
        }
        return fields;
    }
}