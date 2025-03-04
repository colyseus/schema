import "./symbol.shim";
import { Schema } from './Schema';
import { ArraySchema } from './types/custom/ArraySchema';
import { MapSchema } from './types/custom/MapSchema';
import { Metadata } from "./Metadata";
import { $changes, $childType, $descriptors, $numFields, $track } from "./types/symbols";
import { TypeDefinition, getType } from "./types/registry";
import { OPERATION } from "./encoding/spec";
import { TypeContext } from "./types/TypeContext";
import { assertInstanceType, assertType } from "./encoding/assert";
import type { Ref } from "./encoder/ChangeTree";
import type { DefinedSchemaType, InferValueType } from "./types/HelperTypes";
import type { CollectionSchema } from "./types/custom/CollectionSchema";
import type { SetSchema } from "./types/custom/SetSchema";

export type RawPrimitiveType = "string" |
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
    "bigint64" |
    "biguint64";

export type PrimitiveType = RawPrimitiveType | typeof Schema | object;

// TODO: infer "default" value type correctly.
export type DefinitionType<T extends PrimitiveType = PrimitiveType> = T
    | T[]
    | { type: T, default?: InferValueType<T>, view?: boolean | number }
    | { array: T, default?: ArraySchema<InferValueType<T>>, view?: boolean | number }
    | { map: T, default?: MapSchema<InferValueType<T>>, view?: boolean | number }
    | { collection: T, default?: CollectionSchema<InferValueType<T>>, view?: boolean | number }
    | { set: T, default?: SetSchema<InferValueType<T>>, view?: boolean | number };

export type Definition = { [field: string]: DefinitionType };

export interface TypeOptions {
    manual?: boolean,
}

export const DEFAULT_VIEW_TAG = -1;

export function entity(constructor) {
    TypeContext.register(constructor);
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
//         let fieldIndex: number = context.metadata[$numFields] // current structure already has fields defined
//             ?? (parent && parent[$numFields]) // parent structure has fields defined
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

export function view<T> (tag: number = DEFAULT_VIEW_TAG) {
    return function(target: T, fieldName: string) {
        const constructor = target.constructor as typeof Schema;

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass[Symbol.metadata];

        // TODO: use Metadata.initialize()
        const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));
        // const fieldIndex = metadata[fieldName];

        // if (!metadata[fieldIndex]) {
        //     //
        //     // detect index for this field, considering inheritance
        //     //
        //     metadata[fieldIndex] = {
        //         type: undefined,
        //         index: (metadata[$numFields] // current structure already has fields defined
        //             ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
        //             ?? -1) + 1 // no fields defined
        //     }
        // }

        Metadata.setTag(metadata, fieldName, tag);
    }
}

export function unreliable<T> (target: T, field: string) {
    //
    // FIXME: the following block of code is repeated across `@type()`, `@deprecated()` and `@unreliable()` decorators.
    //
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];

    // TODO: use Metadata.initialize()
    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    // if (!metadata[field]) {
    //     //
    //     // detect index for this field, considering inheritance
    //     //
    //     metadata[field] = {
    //         type: undefined,
    //         index: (metadata[$numFields] // current structure already has fields defined
    //             ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
    //             ?? -1) + 1 // no fields defined
    //     }
    // }

    // add owned flag to the field
    metadata[metadata[field]].unreliable = true;
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
        const parentMetadata =  parentClass[Symbol.metadata];
        const metadata = Metadata.initialize(constructor);

        let fieldIndex: number = metadata[field];

        /**
         * skip if descriptor already exists for this field (`@deprecated()`)
         */
        if (metadata[fieldIndex] !== undefined) {
            if (metadata[fieldIndex].deprecated) {
                // do not create accessors for deprecated properties.
                return;

            } else if (metadata[fieldIndex].type !== undefined) {
                // trying to define same property multiple times across inheritance.
                // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                try {
                    throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);

                } catch (e) {
                    const definitionAtLine = e.stack.split("\n")[4].trim();
                    throw new Error(`${e.message} ${definitionAtLine}`);
                }
            }

        } else {
            //
            // detect index for this field, considering inheritance
            //
            fieldIndex = metadata[$numFields] // current structure already has fields defined
                ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
                ?? -1; // no fields defined
            fieldIndex++;
        }

        if (options && options.manual) {
            Metadata.addField(
                metadata,
                fieldIndex,
                field,
                type,
                {
                    // do not declare getter/setter descriptor
                    enumerable: true,
                    configurable: true,
                    writable: true,
                }
            );

        } else {
            const complexTypeKlass = (Array.isArray(type))
                ? getType("array")
                : (typeof(Object.keys(type)[0]) === "string") && getType(Object.keys(type)[0]);

            const childType = (complexTypeKlass)
                ? Object.values(type)[0]
                : type;

            Metadata.addField(
                metadata,
                fieldIndex,
                field,
                type,
                getPropertyDescriptor(`_${field}`, fieldIndex, childType, complexTypeKlass)
            );
        }
    }
}

export function getPropertyDescriptor(
    fieldCached: string,
    fieldIndex: number,
    type: DefinitionType,
    complexTypeKlass: TypeDefinition,
) {
    return {
        get: function () { return this[fieldCached]; },
        set: function (this: Schema, value: any) {
            const previousValue = this[fieldCached] ?? undefined;

            // skip if value is the same as cached.
            if (value === previousValue) { return; }

            if (
                value !== undefined &&
                value !== null
            ) {
                if (complexTypeKlass) {
                    // automaticallty transform Array into ArraySchema
                    if (complexTypeKlass.constructor === ArraySchema && !(value instanceof ArraySchema)) {
                        value = new ArraySchema(...value);
                    }

                    // automaticallty transform Map into MapSchema
                    if (complexTypeKlass.constructor === MapSchema && !(value instanceof MapSchema)) {
                        value = new MapSchema(value);
                    }

                    value[$childType] = type;

                } else if (typeof (type) !== "string") {
                    assertInstanceType(value, type as typeof Schema, this, fieldCached.substring(1));

                } else {
                    assertType(value, type, this, fieldCached.substring(1));
                }

                const changeTree = this[$changes];

                //
                // Replacing existing "ref", remove it from root.
                //
                if (previousValue !== undefined && previousValue[$changes]) {
                    changeTree.root?.remove(previousValue[$changes]);
                    this.constructor[$track](changeTree, fieldIndex, OPERATION.DELETE_AND_ADD);

                } else {
                    this.constructor[$track](changeTree, fieldIndex, OPERATION.ADD);
                }

                //
                // call setParent() recursively for this and its child
                // structures.
                //
                (value as Ref)[$changes]?.setParent(this, changeTree.root, fieldIndex);

            } else if (previousValue !== undefined) {
                //
                // Setting a field to `null` or `undefined` will delete it.
                //
                this[$changes].delete(fieldIndex);
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
        const fieldIndex = metadata[field];

        // if (!metadata[field]) {
        //     //
        //     // detect index for this field, considering inheritance
        //     //
        //     metadata[field] = {
        //         type: undefined,
        //         index: (metadata[$numFields] // current structure already has fields defined
        //             ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
        //             ?? -1) + 1 // no fields defined
        //     }
        // }

        metadata[fieldIndex].deprecated = true;

        if (throws) {
            metadata[$descriptors] ??= {};
            metadata[$descriptors][field] = {
                get: function () { throw new Error(`${field} is deprecated.`); },
                set: function (this: Schema, value: any) { /* throw new Error(`${field} is deprecated.`); */ },
                enumerable: false,
                configurable: true
            };
        }

        // flag metadata[field] as non-enumerable
        Object.defineProperty(metadata, fieldIndex, {
            value: metadata[fieldIndex],
            enumerable: false,
            configurable: true
        });
    }
}

export function defineTypes(
    target: typeof Schema,
    fields: Definition,
    options?: TypeOptions
) {
    for (let field in fields) {
        type(fields[field], options)(target.prototype, field);
    }
    return target;
}

export interface SchemaWithExtends<T extends Definition, P extends typeof Schema> extends DefinedSchemaType<T, P> {
    extends: <T2 extends Definition>(
        fields: T2,
        name?: string
    ) => SchemaWithExtends<T & T2, typeof this>;
}

export function schema<T extends Definition, P extends typeof Schema = typeof Schema>(
    fields: T,
    name?: string,
    inherits: P = Schema as P
): SchemaWithExtends<T, P> {
    const defaultValues: any = {};
    const viewTagFields: any = {};

    for (let fieldName in fields) {
        const field = fields[fieldName] as DefinitionType;
        if (typeof (field) === "object") {
            if (field['default'] !== undefined) {
                defaultValues[fieldName] = field['default'];
            }
            if (field['view'] !== undefined) {
                viewTagFields[fieldName] = (typeof (field['view']) === "boolean")
                    ? DEFAULT_VIEW_TAG
                    : field['view'];
            }
        }
    }

    const klass = Metadata.setFields<any>(class extends inherits {
        constructor (...args: any[]) {
            args[0] = Object.assign({}, defaultValues, args[0]);
            super(...args);
        }
    }, fields) as SchemaWithExtends<T, P>;

    for (let fieldName in viewTagFields) {
        view(viewTagFields[fieldName])(klass.prototype, fieldName);
    }

    if (name) {
        Object.defineProperty(klass, "name", { value: name });
    }

    klass.extends = (fields, name) => schema(fields, name, klass);

    return klass;
}