import "./symbol.shim";
import { Schema } from './Schema';
import { ArraySchema } from './types/custom/ArraySchema';
import { MapSchema, getMapProxy } from './types/custom/MapSchema';
import { Metadata } from "./Metadata";
import { $changes, $childType, $track } from "./types/symbols";

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
    typeof Schema |
    object;

export type DefinitionType = PrimitiveType
    | PrimitiveType[]
    | { array: PrimitiveType }
    | { map: PrimitiveType }
    | { collection: PrimitiveType }
    | { set: PrimitiveType };

export type Definition = { [field: string]: DefinitionType };

export interface TypeOptions {
    manual?: boolean,
}

export class TypeContext {
    types: {[id: number]: typeof Schema} = {};
    schemas = new Map<typeof Schema, number>();

    hasFilters: boolean = false;

    /**
     * For inheritance support
     * Keeps track of which classes extends which. (parent -> children)
     */
    static inheritedTypes = new Map<typeof Schema, Set<typeof Schema>>();

    static register(target: typeof Schema) {
        const parent = Object.getPrototypeOf(target);
        if (parent !== Schema) {
            let inherits = TypeContext.inheritedTypes.get(parent);
            if (!inherits) {
                inherits = new Set<typeof Schema>();
                TypeContext.inheritedTypes.set(parent, inherits);
            }
            inherits.add(target);
        }
    }

    constructor(rootClass?: typeof Schema) {
        // console.log("new TypeContext.........");

        if (rootClass) {
            this.discoverTypes(rootClass);
        }
    }

    has(schema: typeof Schema) {
        return this.schemas.has(schema);
    }

    get(typeid: number) {
        return this.types[typeid];
    }

    add(schema: typeof Schema, typeid: number = this.schemas.size) {
        // skip if already registered
        if (this.schemas.has(schema)) {
            return false;
        }

        this.types[typeid] = schema;
        this.schemas.set(schema, typeid);
        return true;
    }

    getTypeId(klass: typeof Schema) {
        return this.schemas.get(klass);
    }

    private discoverTypes(klass: typeof Schema) {
        if (!this.add(klass)) {
            return;
        }

        // add classes inherited from this base class
        TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
            this.discoverTypes(child);
        });

        // skip if no fields are defined for this class.
        if (klass[Symbol.metadata] === undefined) {
            klass[Symbol.metadata] = {};
        }

        // const metadata = Metadata.getFor(klass);
        const metadata = klass[Symbol.metadata];

        // if any schema/field has filters, mark "context" as having filters.
        if (metadata[-2]) {
            this.hasFilters = true;
        }

        for (const field in metadata) {
            const fieldType = metadata[field].type;

            if (typeof(fieldType) === "string") {
                continue;
            }

            if (Array.isArray(fieldType)) {
                const type = fieldType[0];
                if (type === "string") {
                    continue;
                }
                this.discoverTypes(type as typeof Schema);

            } else if (typeof(fieldType) === "function") {
                this.discoverTypes(fieldType);

            } else {
                const type = Object.values(fieldType)[0];
                if (type === "string") {
                    continue;
                }
                this.discoverTypes(type as typeof Schema);
            }
        }
    }
}

export function entity(constructor, context: ClassDecoratorContext) {
    if (!constructor._definition) {
        // for inheritance support
        TypeContext.register(constructor);
    }

    return constructor;
}

/**
 * [See documentation](https://docs.colyseus.io/state/schema/)
 *
 * Annotate a Schema property to be serializeable.
 * \@type()'d fields are automatically flagged as "dirty" for the next patch.
 *
 * @example Standard usage, with automatic change tracking.
 * ```
 * \@type("string") propertyName: string;
 * ```
 *
 * @example You can provide the "manual" option if you'd like to manually control your patches via .setDirty().
 * ```
 * \@type("string", { manual: true })
 * ```
 */
// export function type(type: DefinitionType, options?: TypeOptions) {
//     return function ({ get, set }, context: ClassAccessorDecoratorContext): ClassAccessorDecoratorResult<Schema, any> {
//         if (context.kind !== "accessor") {
//             throw new Error("@type() is only supported for class accessor properties");
//         }

//         const field = context.name.toString();

//         //
//         // detect index for this field, considering inheritance
//         //
//         const parent = Object.getPrototypeOf(context.metadata);
//         let fieldIndex: number = context.metadata[-1] // current structure already has fields defined
//             ?? (parent && parent[-1]) // parent structure has fields defined
//             ?? -1; // no fields defined
//         fieldIndex++;

//         if (
//             !parent && // the parent already initializes the `$changes` property
//             !Metadata.hasFields(context.metadata)
//         ) {
//             context.addInitializer(function (this: Ref) {
//                 Object.defineProperty(this, $changes, {
//                     value: new ChangeTree(this),
//                     enumerable: false,
//                     writable: true
//                 });
//             });
//         }

//         Metadata.addField(context.metadata, fieldIndex, field, type);

//         const isArray = ArraySchema.is(type);
//         const isMap = !isArray && MapSchema.is(type);

//         // if (options && options.manual) {
//         //     // do not declare getter/setter descriptor
//         //     definition.descriptors[field] = {
//         //         enumerable: true,
//         //         configurable: true,
//         //         writable: true,
//         //     };
//         //     return;
//         // }

//         return {
//             init(value) {
//                 // TODO: may need to convert ArraySchema/MapSchema here

//                 // do not flag change if value is undefined.
//                 if (value !== undefined) {
//                     this[$changes].change(fieldIndex);

//                     // automaticallty transform Array into ArraySchema
//                     if (isArray) {
//                         if (!(value instanceof ArraySchema)) {
//                             value = new ArraySchema(...value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // automaticallty transform Map into MapSchema
//                     if (isMap) {
//                         if (!(value instanceof MapSchema)) {
//                             value = new MapSchema(value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // try to turn provided structure into a Proxy
//                     if (value['$proxy'] === undefined) {
//                         if (isMap) {
//                             value = getMapProxy(value);
//                         }
//                     }

//                 }

//                 return value;
//             },

//             get() {
//                 return get.call(this);
//             },

//             set(value: any) {
//                 /**
//                  * Create Proxy for array or map items
//                  */

//                 // skip if value is the same as cached.
//                 if (value === get.call(this)) {
//                     return;
//                 }

//                 if (
//                     value !== undefined &&
//                     value !== null
//                 ) {
//                     // automaticallty transform Array into ArraySchema
//                     if (isArray) {
//                         if (!(value instanceof ArraySchema)) {
//                             value = new ArraySchema(...value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // automaticallty transform Map into MapSchema
//                     if (isMap) {
//                         if (!(value instanceof MapSchema)) {
//                             value = new MapSchema(value);
//                         }
//                         value[$childType] = Object.values(type)[0];
//                     }

//                     // try to turn provided structure into a Proxy
//                     if (value['$proxy'] === undefined) {
//                         if (isMap) {
//                             value = getMapProxy(value);
//                         }
//                     }

//                     // flag the change for encoding.
//                     this[$changes].change(fieldIndex);

//                     //
//                     // call setParent() recursively for this and its child
//                     // structures.
//                     //
//                     if (value[$changes]) {
//                         value[$changes].setParent(
//                             this,
//                             this[$changes].root,
//                             Metadata.getIndex(context.metadata, field),
//                         );
//                     }

//                 } else if (get.call(this)) {
//                     //
//                     // Setting a field to `null` or `undefined` will delete it.
//                     //
//                     this[$changes].delete(field);
//                 }

//                 set.call(this, value);
//             },
//         };
//     }
// }

export function owned<T> (target: T, field: string) {
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];
    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    if (!metadata[field]) {
        //
        // detect index for this field, considering inheritance
        //
        metadata[field] = {
            type: undefined,
            index: (metadata[-1] // current structure already has fields defined
                ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                ?? -1) + 1 // no fields defined

        }
    }

    // add owned flag to the field
    metadata[field].owned = true;

    // map "-2" index as "has filters"
    Object.defineProperty(metadata, -2, {
        value: true,
        enumerable: false,
        configurable: true
    });
}

export function unreliable<T> (target: T, field: string) {
    //
    // FIXME: the following block of code is repeated across `@type()`, `@deprecated()` and `@unreliable()` decorators.
    //
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];
    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    if (!metadata[field]) {
        //
        // detect index for this field, considering inheritance
        //
        metadata[field] = {
            type: undefined,
            index: (metadata[-1] // current structure already has fields defined
                ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                ?? -1) + 1 // no fields defined
        }
    }

    // add owned flag to the field
    metadata[field].unreliable = true;
}

export function type (
    type: DefinitionType,
    options?: TypeOptions
): PropertyDecorator {
    return function (target: typeof Schema, field: string) {
        const constructor = target.constructor as typeof Schema;

        if (!type) {
            throw new Error(`${constructor.name}: @type() reference provided for "${field}" is undefined. Make sure you don't have any circular dependencies.`);
        }

        // for inheritance support
        TypeContext.register(constructor);

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass[Symbol.metadata];
        const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

        let fieldIndex: number;

        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (metadata[field]) {
            if (metadata[field].deprecated) {
                // do not create accessors for deprecated properties.
                return;

            } else if (metadata[field].descriptor !== undefined) {
                // trying to define same property multiple times across inheritance.
                // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                try {
                    throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);

                } catch (e) {
                    const definitionAtLine = e.stack.split("\n")[4].trim();
                    throw new Error(`${e.message} ${definitionAtLine}`);
                }

            } else {
                fieldIndex = metadata[field].index;
            }

        } else {
            //
            // detect index for this field, considering inheritance
            //
            fieldIndex = metadata[-1] // current structure already has fields defined
                ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                ?? -1; // no fields defined
            fieldIndex++;
        }

        if (options && options.manual) {
            Metadata.addField(metadata, fieldIndex, field, type, {
                // do not declare getter/setter descriptor
                enumerable: true,
                configurable: true,
                writable: true,
            });

        } else {
            const isArray = ArraySchema.is(type);
            const isMap = !isArray && MapSchema.is(type);
            Metadata.addField(metadata, fieldIndex, field, type, getPropertyDescriptor(`_${field}`, fieldIndex, type, isArray, isMap, metadata, field));
        }
    }
}

export function getPropertyDescriptor(fieldCached: string, fieldIndex: number, type: DefinitionType, isArray: boolean, isMap: boolean, metadata: Metadata, field: string) {
    return {
        get: function () { return this[fieldCached]; },

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
                if (isArray) {
                    if (!(value instanceof ArraySchema)) {
                        value = new ArraySchema(...value);
                    }
                    value[$childType] = Object.values(type)[0];
                }

                // automaticallty transform Map into MapSchema
                if (isMap) {
                    if (!(value instanceof MapSchema)) {
                        value = new MapSchema(value);
                    }
                    value[$childType] = Object.values(type)[0];
                }

                // try to turn provided structure into a Proxy
                if (value['$proxy'] === undefined) {
                    if (isMap) {
                        value = getMapProxy(value);
                    }
                }

                // flag the change for encoding.
                // this[$changes].change(fieldIndex);
                this.constructor[$track](this[$changes], fieldIndex);

                //
                // call setParent() recursively for this and its child
                // structures.
                //
                if (value[$changes]) {
                    value[$changes].setParent(
                        this,
                        this[$changes].root,
                        metadata[field].index,
                    );
                }

            } else if (this[fieldCached]) {
                //
                // Setting a field to `null` or `undefined` will delete it.
                //
                this[$changes].delete(field);
            }

            this[fieldCached] = value;
        },

        enumerable: true,
        configurable: true
    };
}

/**
 * `@deprecated()` flag a field as deprecated.
 * The previous `@type()` annotation should remain along with this one.
 */

export function deprecated(throws: boolean = true): PropertyDecorator {
    return function (klass: typeof Schema, field: string) {
        //
        // FIXME: the following block of code is repeated across `@type()`, `@deprecated()` and `@unreliable()` decorators.
        //
        const constructor = klass.constructor as typeof Schema;

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass[Symbol.metadata];
        const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

        if (!metadata[field]) {
            //
            // detect index for this field, considering inheritance
            //
            metadata[field] = {
                type: undefined,
                index: (metadata[-1] // current structure already has fields defined
                    ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                    ?? -1) + 1 // no fields defined
            }
        }

        metadata[field].deprecated = true;

        if (throws) {
            metadata[field].descriptor = {
                get: function () { throw new Error(`${field} is deprecated.`); },
                set: function (this: Schema, value: any) { /* throw new Error(`${field} is deprecated.`); */ },
                enumerable: false,
                configurable: true
            }
        }
    }
}

export function defineTypes(
    target: typeof Schema,
    fields: { [property: string]: DefinitionType },
    options?: TypeOptions
) {
    for (let field in fields) {
        type(fields[field], options)(target.prototype, field);
    }
    return target;
}
