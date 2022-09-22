import { ClientWithSessionId, Context, globalContext } from './Context';
import { Schema } from '../Schema';
import { DefinitionType, SchemaDefinition } from './SchemaDefinition';
import { ArraySchema, getArrayProxy } from '../types/ArraySchema';
import { getMapProxy, MapSchema } from '../types/MapSchema';
import { ChangeTree } from '../changes/ChangeTree';


export type FilterCallback<
    T extends Schema = any,
    V = any,
    R extends Schema = any
> = (
    ((this: T, client: ClientWithSessionId, value: V) => boolean) |
    ((this: T, client: ClientWithSessionId, value: V, root: R) => boolean)
);

export type FilterChildrenCallback<
    T extends Schema = any,
    K = any,
    V = any,
    R extends Schema = any
> = (
    ((this: T, client: ClientWithSessionId, key: K, value: V) => boolean) |
    ((this: T, client: ClientWithSessionId, key: K, value: V, root: R) => boolean)
);

/**
 * `@type()` decorator for proxies
 */
export function type (type: DefinitionType, context: Context = globalContext): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        if (!type) {
            throw new Error("Type not found. Ensure your `@type` annotations are correct and that you don't have any circular dependencies.");
        }

        const constructor = target.constructor as typeof Schema;
        constructor._context = context;

        /*
         * static schema
         */
        if (!context.has(constructor)) {
            context.add(constructor);
        }

        const definition = constructor._definition;
        definition.addField(field, type);

        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (definition.descriptors[field]) {
            if (definition.deprecated[field]) {
                // do not create accessors for deprecated properties.
                return;

            } else {
                // trying to define same property multiple times across inheritance.
                // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                try {
                    throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);

                } catch (e) {
                    const definitionAtLine = e.stack.split("\n")[4].trim();
                    throw new Error(`${e.message} ${definitionAtLine}`);
                }
            }
        }

        const isArray = ArraySchema.is(type);
        const isMap = !isArray && MapSchema.is(type);

        // TODO: refactor me.
        // Allow abstract intermediary classes with no fields to be serialized
        // (See "should support an inheritance with a Schema type without fields" test)
        if (typeof (type) !== "string" && !Schema.is(type)) {
            const childType = Object.values(type)[0];
            if (typeof (childType) !== "string" && !context.has(childType)) {
                context.add(childType);
            }
        }

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

                if (
                    value !== undefined &&
                    value !== null
                ) {
                    // automaticallty transform Array into ArraySchema
                    if (isArray && !(value instanceof ArraySchema)) {
                        value = new ArraySchema(...value);
                    }

                    // automaticallty transform Map into MapSchema
                    if (isMap && !(value instanceof MapSchema)) {
                        value = new MapSchema(value);
                    }

                    // try to turn provided structure into a Proxy
                    if (value['$proxy'] === undefined) {
                        if (isMap) {
                            value = getMapProxy(value);

                        } else if (isArray) {
                            value = getArrayProxy(value);
                        }
                    }

                    // flag the change for encoding.
                    this.$changes.change(field);

                    //
                    // call setParent() recursively for this and its child
                    // structures.
                    //
                    if (value['$changes']) {
                        (value['$changes'] as ChangeTree).setParent(
                            this,
                            this.$changes.root,
                            this._definition.indexes[field],
                        );
                    }

                } else {
                    //
                    // Setting a field to `null` or `undefined` will delete it.
                    //
                    this.$changes.delete(field);
                }

                this[fieldCached] = value;
            },

            enumerable: true,
            configurable: true
        };
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

export function hasFilter(klass: typeof Schema) {
    return klass._context && klass._context.useFilters;
}

function applyFilter(addFilter:(definition: SchemaDefinition, field: string) => boolean) {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;
        const definition = constructor._definition;
        if (addFilter(definition, field)) {
            constructor._context.useFilters = true;
        }
    }
}

/**
 * `@filter()` decorator for defining data filters per client
 */

export function filter<T extends Schema, V, R extends Schema>(cb: FilterCallback<T, V, R>): PropertyDecorator {
    return applyFilter((definition, field) => definition.addFilter(field, cb))
}

/**
 * `@filterChildren()` decorator for defining data filters per client
 */

export function filterChildren<T extends Schema, K, V, R extends Schema>(cb: FilterChildrenCallback<T, K, V, R>): PropertyDecorator {
    return applyFilter((definition, field) => definition.addChildrenFilter(field, cb))
}

export { ClientWithSessionId, Context, globalContext } from "./Context";
export { SchemaDefinition, Definition, DefinitionType, PrimitiveType } from "./SchemaDefinition";
export { DefinitionTypeOptions, defineTypes } from "./defineTypes";
