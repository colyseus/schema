import "./symbol.shim.js";
import { Schema } from './Schema.js';
import { ArraySchema } from './types/custom/ArraySchema.js';
import { MapSchema } from './types/custom/MapSchema.js';
import { getNormalizedType, Metadata } from "./Metadata.js";
import { $changes, $childType, $descriptors, $encoders, $numFields, $track, $values } from "./types/symbols.js";
import { encode } from "./encoding/encode.js";
import { TypeDefinition, getType } from "./types/registry.js";
import { OPERATION } from "./encoding/spec.js";
import { TypeContext } from "./types/TypeContext.js";
import { assertInstanceType, assertType } from "./encoding/assert.js";
import type { InferValueType, InferSchemaInstanceType, AssignableProps, IsNever } from "./types/HelperTypes.js";
import { CollectionSchema } from "./types/custom/CollectionSchema.js";
import { SetSchema } from "./types/custom/SetSchema.js";
import { FieldBuilder, isBuilder } from "./types/builder.js";

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
    | { type: T, default?: InferValueType<T>, view?: boolean | number, sync?: boolean, owned?: boolean }
    | { array: T, default?: ArraySchema<InferValueType<T>>, view?: boolean | number, sync?: boolean, owned?: boolean }
    | { map: T, default?: MapSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean, owned?: boolean }
    | { collection: T, default?: CollectionSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean, owned?: boolean }
    | { set: T, default?: SetSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean, owned?: boolean };

export type Definition = { [field: string]: DefinitionType };

export interface TypeOptions {
    manual?: boolean,
}

export const DEFAULT_VIEW_TAG = -1;

export function entity(constructor: any): any {
    TypeContext.register(constructor as typeof Schema);
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

export function owned<T> (target: T, field: string) {
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];

    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    metadata[metadata[field]].owned = true;
}

export function unreliable<T> (target: T, field: string) {
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];

    // TODO: use Metadata.initialize()
    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    Metadata.setUnreliable(metadata, field);
}

/**
 * @transient — mark a field as not persisted to snapshots (encodeAll /
 * encodeAllView). Transient fields are still emitted on per-tick patches
 * (reliable or unreliable), but late-joining clients won't see them until
 * the next mutation.
 *
 * Orthogonal to @unreliable: a field can be either, both, or neither.
 */
export function transient<T> (target: T, field: string) {
    const constructor = target.constructor as typeof Schema;

    const parentClass = Object.getPrototypeOf(constructor);
    const parentMetadata = parentClass[Symbol.metadata];

    const metadata: Metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));

    Metadata.setTransient(metadata, field);
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

        // Normalize type (enum/collection/etc)
        type = getNormalizedType(type);

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
            const complexTypeKlass = typeof(Object.keys(type)[0]) === "string" && getType(Object.keys(type)[0]);

            const childType = (complexTypeKlass)
                ? Object.values(type)[0]
                : type;

            Metadata.addField(
                metadata,
                fieldIndex,
                field,
                type,
                getPropertyDescriptor(field, fieldIndex, childType, complexTypeKlass)
            );
        }

        // Install accessor descriptor on the prototype (once per class field).
        if (metadata[$descriptors][field]) {
            Object.defineProperty(target, field, metadata[$descriptors][field]);
        }

        // Pre-compute encoder function for primitive types.
        if (typeof type === "string") {
            if (!metadata[$encoders]) {
                Object.defineProperty(metadata, $encoders, {
                    value: [],
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            }
            metadata[$encoders][fieldIndex] = (encode as any)[type];
        }
    }
}

export function getPropertyDescriptor(
    fieldName: string,
    fieldIndex: number,
    type: DefinitionType,
    complexTypeKlass: TypeDefinition,
) {
    return {
        get: function (this: Schema) { return this[$values][fieldIndex]; },
        set: function (this: Schema, value: any) {
            const previousValue = this[$values][fieldIndex] ?? undefined;

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
                    assertInstanceType(value, type as typeof Schema, this, fieldName);

                } else {
                    assertType(value, type, this, fieldName);
                }

                const changeTree = this[$changes];

                //
                // Replacing existing "ref", remove it from root.
                //
                if (previousValue !== undefined && previousValue[$changes]) {
                    changeTree.root?.remove(previousValue[$changes]);
                    (this.constructor as typeof Schema)[$track](changeTree, fieldIndex, OPERATION.DELETE_AND_ADD);

                } else {
                    (this.constructor as typeof Schema)[$track](changeTree, fieldIndex, OPERATION.ADD);
                }

                //
                // call setParent() recursively for this and its child
                // structures.
                //
                value[$changes]?.setParent(this, changeTree.root, fieldIndex);

            } else if (previousValue !== undefined) {
                //
                // Setting a field to `null` or `undefined` will delete it.
                //
                this[$changes].delete(fieldIndex);
            }

            this[$values][fieldIndex] = value;
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
            // Override accessor on the prototype so deprecated throws at access.
            Object.defineProperty(klass, field, metadata[$descriptors][field]);
        }

        // flag metadata[field] as non-enumerable
        Object.defineProperty(metadata, fieldIndex, {
            value: metadata[fieldIndex],
            enumerable: false,
            configurable: true
        });
    }
}

// Helper type to extract InitProps from initialize method
// Supports both single object parameter and multiple parameters
// If no initialize method is specified, use AssignableProps for field initialization
type ExtractInitProps<T> = T extends { initialize: (...args: infer P) => void }
    ? P extends readonly []
        ? never
        : P extends readonly [infer First]
            ? First extends object
                ? First
                : P
            : P
    : AssignableProps<InferSchemaInstanceType<T>>;

// Helper type to determine if InitProps should be required
type IsInitPropsRequired<T> = T extends { initialize: (props: any) => void }
    ? true
    : T extends { initialize: (...args: infer P) => void }
        ? P extends readonly []
            ? false
            : true
        : false;

/**
 * A `schema()` field definition accepts a FieldBuilder, a Schema subclass
 * (shorthand for `t.ref(Class)`), or a method (attached to the prototype).
 */
export type FieldsAndMethods = Record<string, FieldBuilder<any> | (new (...args: any[]) => Schema) | Function>;

export interface SchemaWithExtends<T, P extends typeof Schema> {
    extend: <T2 extends FieldsAndMethods = FieldsAndMethods>(
        fields: T2 & ThisType<InferSchemaInstanceType<T & T2>>,
        name?: string,
    ) => SchemaWithExtendsConstructor<T & T2, ExtractInitProps<T2>, P>;
}

/**
 * Get the type of the schema defined via `schema('Name', {...})` method.
 *
 * @example
 * const Entity = schema('Entity', {
 *     x: t.number(),
 *     y: t.number(),
 * });
 * type Entity = SchemaType<typeof Entity>;
 */
export type SchemaType<T extends {'~type': any}> = T['~type'];

export interface SchemaWithExtendsConstructor<
    T,
    InitProps,
    P extends typeof Schema
> extends SchemaWithExtends<T, P> {
    '~type': InferSchemaInstanceType<T>;
    new (...args: [InitProps] extends [never] ? [] : InitProps extends readonly any[] ? InitProps : IsInitPropsRequired<T> extends true ? [InitProps] : [InitProps?]): InferSchemaInstanceType<T> & InstanceType<P>;
    prototype: InferSchemaInstanceType<T> & InstanceType<P> & {
        initialize(...args: [InitProps] extends [never] ? [] : InitProps extends readonly any[] ? InitProps : [InitProps]): void;
    };
}

/**
 * Define a Schema class declaratively.
 *
 * @example
 * import { schema, t } from '@colyseus/schema';
 *
 * const Player = schema({
 *   hp: t.uint8().default(100),
 *   name: t.string().view(),
 *   takeDamage(n: number) { this.hp -= n; },
 * }, 'Player');
 *
 * const Warrior = Player.extend({
 *   weapon: t.string(),
 * }, 'Warrior');
 */
export function schema<
    T extends FieldsAndMethods,
    P extends typeof Schema = typeof Schema
>(
    fieldsAndMethods: T & ThisType<InferSchemaInstanceType<T>>,
    name?: string,
    inherits: P = Schema as P,
): SchemaWithExtendsConstructor<T, ExtractInitProps<T>, P> {
    if (fieldsAndMethods == null || typeof fieldsAndMethods !== "object") {
        throw new Error(`schema(): first argument must be a fields object (got ${typeof fieldsAndMethods}).`);
    }

    const fields: any = {};
    const methods: any = {};
    const defaultValues: any = {};
    const viewTagFields: { [field: string]: number } = {};
    const ownedFields: string[] = [];
    const unreliableFields: string[] = [];
    const transientFields: string[] = [];
    const deprecatedFields: { [field: string]: boolean } = {};
    const staticFields: string[] = [];
    const streamFields: string[] = [];

    for (const fieldName in fieldsAndMethods) {
        const value: any = (fieldsAndMethods as any)[fieldName];

        if (isBuilder(value)) {
            const def = value.toDefinition();
            fields[fieldName] = getNormalizedType(def.type);

            if (def.view !== undefined) { viewTagFields[fieldName] = def.view; }
            if (def.owned) { ownedFields.push(fieldName); }
            if (def.unreliable) { unreliableFields.push(fieldName); }
            if (def.transient) { transientFields.push(fieldName); }
            if (def.deprecated) { deprecatedFields[fieldName] = def.deprecatedThrows; }
            if (def.static) { staticFields.push(fieldName); }
            if (def.stream) { streamFields.push(fieldName); }

            if (def.hasDefault) {
                defaultValues[fieldName] = def.default;
            } else {
                // Auto-instantiate collection/Schema defaults when none is provided.
                const rawType: any = def.type;
                if (rawType && typeof rawType === "object") {
                    if (rawType.array !== undefined) {
                        defaultValues[fieldName] = new ArraySchema();
                    } else if (rawType.map !== undefined) {
                        defaultValues[fieldName] = new MapSchema();
                    } else if (rawType.set !== undefined) {
                        defaultValues[fieldName] = new SetSchema();
                    } else if (rawType.collection !== undefined) {
                        defaultValues[fieldName] = new CollectionSchema();
                    }
                } else if (typeof rawType === "function" && Schema.is(rawType)) {
                    if (!rawType.prototype.initialize || rawType.prototype.initialize.length === 0) {
                        defaultValues[fieldName] = new rawType();
                    }
                }
            }

        } else if (typeof value === "function") {
            if (Schema.is(value)) {
                // Convenience: allow a bare Schema subclass (equivalent to `t.ref(Class)`).
                fields[fieldName] = getNormalizedType(value);
                if (!value.prototype.initialize || value.prototype.initialize.length === 0) {
                    defaultValues[fieldName] = new value();
                }
            } else {
                methods[fieldName] = value;
            }

        } else {
            throw new Error(
                `schema(${name ? `'${name}'` : ""}): field '${fieldName}' must be a t.* builder, ` +
                `Schema subclass, or method (got ${typeof value}).`
            );
        }
    }

    const getDefaultValues = () => {
        const defaults: any = {};
        for (const fieldName in defaultValues) {
            const defaultValue = defaultValues[fieldName];
            if (defaultValue && typeof defaultValue.clone === "function") {
                defaults[fieldName] = defaultValue.clone();
            } else {
                defaults[fieldName] = defaultValue;
            }
        }
        return defaults;
    };

    const getParentProps = (props: any) => {
        const fieldNames = Object.keys(fields);
        const parentProps: any = {};
        for (const key in props) {
            if (!fieldNames.includes(key)) {
                parentProps[key] = props[key];
            }
        }
        return parentProps;
    };

    /** @codegen-ignore */
    const klass = Metadata.setFields<any>(class extends (inherits as any) {
        constructor(...args: any[]) {
            if (methods.initialize && typeof methods.initialize === "function") {
                super(Object.assign({}, getDefaultValues(), getParentProps(args[0] || {})));
                // Only call initialize() on the exact target class, not parents.
                if (new.target === klass) {
                    methods.initialize.apply(this, args);
                }
            } else {
                super(Object.assign({}, getDefaultValues(), args[0] || {}));
            }
        }
    }, fields) as unknown as SchemaWithExtendsConstructor<T, ExtractInitProps<T>, P>;

    (klass as any)._getDefaultValues = getDefaultValues;

    Object.assign(klass.prototype, methods);

    for (const fieldName in viewTagFields) {
        view(viewTagFields[fieldName])(klass.prototype, fieldName);
    }
    for (const fieldName of ownedFields) {
        owned(klass.prototype, fieldName);
    }
    for (const fieldName of unreliableFields) {
        unreliable(klass.prototype, fieldName);
    }
    for (const fieldName of transientFields) {
        transient(klass.prototype, fieldName);
    }
    for (const fieldName in deprecatedFields) {
        deprecated(deprecatedFields[fieldName])(klass.prototype, fieldName);
    }

    // `.static()` wires into the encoder via Metadata.setStatic; `.stream()`
    // remains flag-only until that work lands.
    if (staticFields.length > 0 || streamFields.length > 0) {
        const metadata = (klass as any)[Symbol.metadata] as Metadata;
        for (const fieldName of staticFields) {
            Metadata.setStatic(metadata, fieldName);
        }
        for (const fieldName of streamFields) {
            metadata[metadata[fieldName]].stream = true;
        }
    }

    if (name) {
        Object.defineProperty(klass, "name", { value: name });
    }

    (klass as any).extend = <T2 extends FieldsAndMethods = FieldsAndMethods>(
        childFields: T2,
        childName?: string,
    ) => schema<T2>(childFields, childName, klass as any);

    return klass;
}
