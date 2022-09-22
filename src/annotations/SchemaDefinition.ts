import { FilterCallback, FilterChildrenCallback } from '.';
import { getType } from '../types';
import { Schema } from '../Schema';

/**
 * Data Types
 */

export type PrimitiveType =
    "string" |
    "number" |
    "boolean" |
    "int8" |
    "uint8" |
    "int16" |
    "uint16" |
    "int32" |
    "uint32" |
    "int64" |
    "uint64" |
    "float32" |
    "float64" |
    typeof Schema;

export type DefinitionType = PrimitiveType
    | [PrimitiveType]
    | { array: PrimitiveType }
    | { map: PrimitiveType }
    | { collection: PrimitiveType }
    | { set: PrimitiveType };

export type Definition = { [field: string]: DefinitionType };

export class SchemaDefinition {
    schema: Definition;

    //
    // TODO: use a "field" structure combining all these properties per-field.
    //

    indexes: { [field: string]: number } = {};
    fieldsByIndex: { [index: number]: string } = {};

    filters: { [field: string]: FilterCallback };
    indexesWithFilters: number[];
    childFilters: { [field: string]: FilterChildrenCallback }; // childFilters are used on Map, Array, Set items.

    deprecated: { [field: string]: boolean } = {};
    descriptors: PropertyDescriptorMap & ThisType<any> = {};

    static create(parent?: SchemaDefinition) {
        const definition = new SchemaDefinition();

        // support inheritance
        definition.schema = Object.assign({}, parent && parent.schema || {});
        definition.indexes = Object.assign({}, parent && parent.indexes || {});
        definition.fieldsByIndex = Object.assign({}, parent && parent.fieldsByIndex || {});
        definition.descriptors = Object.assign({}, parent && parent.descriptors || {});
        definition.deprecated = Object.assign({}, parent && parent.deprecated || {});

        return definition;
    }

    addField(field: string, type: DefinitionType) {
        const index = this.getNextFieldIndex();
        this.fieldsByIndex[index] = field;
        this.indexes[field] = index;
        this.schema[field] = (Array.isArray(type))
            ? { array: type[0] }
            : type;
    }

    addFilter(field: string, cb: FilterCallback) {
        if (!this.filters) {
            this.filters = {};
            this.indexesWithFilters = [];
        }
        this.filters[this.indexes[field]] = cb;
        this.indexesWithFilters.push(this.indexes[field]);
        return true;
    }

    addChildrenFilter(field: string, cb: FilterChildrenCallback) {
        const index = this.indexes[field];
        const type = this.schema[field];

        if (getType(Object.keys(type)[0])) {
            if (!this.childFilters) { this.childFilters = {}; }

            this.childFilters[index] = cb;
            return true;

        } else {
            console.warn(`@filterChildren: field '${field}' can't have children. Ignoring filter.`);
        }
    }

    getChildrenFilter(field: string) {
        return this.childFilters && this.childFilters[this.indexes[field]];
    }

    getNextFieldIndex() {
        return Object.keys(this.schema || {}).length;
    }
}