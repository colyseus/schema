import { ChangeTree } from './changes/ChangeTree';
import { Schema } from './Schema';
import { ArraySchema } from './types/ArraySchema';
import { MapSchema } from './types/MapSchema';

/**
 * Data types
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

export type DefinitionType = ( PrimitiveType | PrimitiveType[] | { map: PrimitiveType });
export type Definition = { [field: string]: DefinitionType };
export type FilterCallback<
    T extends Schema = any,
    V = any,
    R extends Schema = any
> = (this: T, client: Client, value: V, root?: R) => boolean;

export type FilterChildrenCallback<
    T extends Schema = any,
    K = any,
    V = any,
    R extends Schema = any
> = (this: T, client: Client, key: K, value: V, root?: R) => boolean;

export class SchemaDefinition {
    schema: Definition;

    //
    // TODO: use a "field" structure combining all these properties per-field.
    //

    indexes: { [field: string]: number };
    fieldsByIndex: { [index: number]: string };

    filters: { [field: string]: FilterCallback };
    childFilters: { [field: string]: FilterCallback }; // childFilters are used on Map, Array, Set items.

    deprecated: { [field: string]: boolean };
    descriptors: PropertyDescriptorMap & ThisType<any>;

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
        console.log("ADD FIELD", field, type);
        const index = this.getNextFieldIndex();
        this.fieldsByIndex[index] = field;
        this.indexes[field] = index;
        this.schema[field] = type;
    }

    addFilter(field: string, cb: FilterCallback) {
        if (!this.filters) {
            this.filters = {};
        }

        this.filters[this.indexes[field]] = cb;
    }

    addChildrenFilter(field: string, cb: FilterChildrenCallback) {
        const type = this.schema[field];
        const index = this.indexes[field];

        if (
            ArraySchema.is(type) ||
            MapSchema.is(type)
        ) {
            if (!this.childFilters) { this.childFilters = {}; }

            this.childFilters[index] = cb;

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

// Colyseus integration
export type Client = { sessionId: string } & any;

export class Context {
    types: {[id: number]: typeof Schema} = {};
    schemas = new Map<typeof Schema, number>();

    has(schema: typeof Schema) {
        return this.schemas.has(schema);
    }

    get(typeid: number) {
        return this.types[typeid];
    }

    add(schema: typeof Schema) {
        schema._typeid = this.schemas.size;
        this.types[schema._typeid] = schema;
        this.schemas.set(schema, schema._typeid);
    }
}

export const globalContext = new Context();

/**
 * `@type()` decorator for proxies
 */

export function type (type: DefinitionType, context: Context = globalContext): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;
        constructor._context = context;

        /*
         * static schema
         */
        if (!context.has(constructor)) {
            context.add(constructor);

            // support inheritance
            constructor._definition = SchemaDefinition.create(constructor._definition);
        }

        const definition = constructor._definition;
        definition.addField(field, type);

        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (definition.descriptors[field]) { return; }

        const isArray = ArraySchema.is(type);
        const isMap = !isArray && MapSchema.is(type);
        const isSchema = Schema.is(type);

        const fieldCached = `_${field}`;

        definition.descriptors[fieldCached] = {
            enumerable: false,
            configurable: false,
            writable: true,
        };

        definition.descriptors[field] = {
            get: function () {
                return this[fieldCached];
            },

            set: function (this: Schema, value: any) {
                /**
                 * Create Proxy for array or map items
                 */

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                // automaticallty transform Array into ArraySchema
                if (isArray && !(value instanceof ArraySchema)) {
                    value = new ArraySchema(...value);
                }

                // automaticallty transform Map into MapSchema
                if (isMap && !(value instanceof MapSchema)) {
                    value = new MapSchema(value);
                }

                // if (isArray || isMap) {
                if (isArray) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, setValue) => {
                            // if (prop !== "length" && (prop as string).indexOf("$") !== 0) {
                            //     // ensure new value has a parent
                            //     const key = (isArray) ? Number(prop) : String(prop);

                            //     if (!obj.$sorting) {
                            //         // track index change
                            //         const previousIndex = obj.$changes.getIndex(setValue);
                            //         if (previousIndex !== undefined) {
                            //             obj.$changes.mapIndexChange(setValue, previousIndex);
                            //         }
                            //         obj.$changes.mapIndex(setValue, key);
                            //     }

                            //     if (setValue instanceof Schema) {
                            //         // new items are flagged with all changes
                            //         if (!setValue.$changes.parent) {
                            //             setValue.$changes = new ChangeTree(setValue._indexes, key, obj.$changes);
                            //             setValue.$changes.changeAll(setValue);
                            //         }

                            //     } else {
                            //         obj[prop] = setValue;
                            //     }

                            //     // apply change on ArraySchema / MapSchema
                            //     obj.$changes.change(key);
                            // }

                            obj[prop] = setValue;

                            return true;
                        },

                        deleteProperty: (obj, prop) => {
                            const deletedValue = obj[prop];

                            // if (isMap && deletedValue !== undefined) {
                            //     obj.$changes.deleteIndex(deletedValue);
                            //     obj.$changes.deleteIndexChange(deletedValue);

                            //     if (deletedValue.$changes) { // deletedValue may be a primitive value
                            //         delete deletedValue.$changes.parent;
                            //     }

                            //     // obj._indexes.delete(prop);
                            // }

                            delete obj[prop];

                            const key = (isArray) ? Number(prop) : String(prop);
                            obj.$changes.delete(key);

                            return true;
                        },
                    });
                }

                this[fieldCached] = value;

                const $root = this.$changes.root;

                if (isArray) {
                    // directly assigning an array of items as value.
                    this.$changes.change(field);

                    value.$changes.setParent(
                        this.$changes,
                        $root,
                        definition.schema[field],
                        definition.getChildrenFilter(field),
                    );
                    // value.$changes = new ChangeTree(value, {}, this.$changes, $root);

                    for (let i = 0; i < value.length; i++) {
                        if (value[i] instanceof Schema) {
                            value[i].$changes.setParent(value.$changes, $root);
                            // value[i].$changes = new ChangeTree(value[i], value[i]._indexes, value.$changes, $root);
                            // value[i].$changes.changeAll(value[i]);
                        }
                        value.$changes.mapIndex(value[i], i);
                        value.$changes.change(i);
                    }

                } else if (isMap) {
                    console.log("DIRECTLY ASSIGNING A MAP, type =>", (definition.schema[field] as any).map);

                    // directly assigning a map
                    value.$changes.setParent(
                        this.$changes,
                        $root,
                        (definition.schema[field] as any).map,
                        definition.getChildrenFilter(field),
                    );

                    this.$changes.change(field);

                    (value as MapSchema).forEach((val, key) => {
                        console.log("FLAG AS CHANGED:", key);
                        if (val instanceof Schema) {
                            val.$changes.setParent(
                                value.$changes,
                                $root,
                            );
                            // val.$changes.changeAll(val);
                        }
                        // value.$changes.mapIndex(val, key);
                        value.$changes.change(key);
                    });

                } else if (isSchema) {
                    // directly assigning a `Schema` object
                    // value may be set to null
                    this.$changes.change(field);

                    if (value) {
                        value.$changes.setParent(
                            this.$changes,
                            $root,
                            // definition.schema[field],
                        );
                    }

                } else {
                    // directly assigning a primitive type
                    this.$changes.change(field);
                }
            },

            enumerable: true,
            configurable: true
        };
    }
}

/**
 * `@filter()` decorator for defining data filters per client
 */

export function filter<T extends Schema, V, R extends Schema>(cb: FilterCallback<T, V, R>): PropertyDecorator {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;
        const definition = constructor._definition;
        definition.addFilter(field, cb);
    }
}

export function filterChildren<T extends Schema, K, V, R extends Schema>(cb: FilterChildrenCallback<T, K, V, R>): PropertyDecorator {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;
        const definition = constructor._definition;
        definition.addChildrenFilter(field, cb);
    }
}


/**
 * `@deprecated()` flag a field as deprecated.
 * The previous `@type()` annotation should remain along with this one.
 */

export function deprecated(throws: boolean = true, context: Context = globalContext): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;
        const definition = constructor._definition;

        definition.deprecated[field] = true;

        if (throws) {
            definition.descriptors[field] = {
                get: function () { throw new Error(`${field} is deprecated.`); },
                set: function (this: Schema, value: any) { /* throw new Error(`${field} is deprecated.`); */ },
                enumerable: false,
                configurable: true
            };
        }
    }
}

export function defineTypes(target: typeof Schema, fields: {[property: string]: DefinitionType}, context: Context = globalContext) {
    for (let field in fields) {
        type(fields[field], context)(target.prototype, field);
    }
    return target;
}
