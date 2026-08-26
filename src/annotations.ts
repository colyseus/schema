import "./symbol.shim.js";
import { Schema } from './Schema.js';
import { ArraySchema } from './types/custom/ArraySchema.js';
import { MapSchema } from './types/custom/MapSchema.js';
import { getNormalizedType, Metadata, resolveFieldType } from "./Metadata.js";
import { $changes, $childType, $descriptors, $encoders, $numFields, $track, $values } from "./types/symbols.js";
import { encode } from "./encoding/encode.js";
import { TypeDefinition, getType } from "./types/registry.js";
import { OPERATION } from "./encoding/spec.js";
import { TypeContext } from "./types/TypeContext.js";
import { assertInstanceType, assertType, EncodeSchemaError } from "./encoding/assert.js";
import type { InferValueType, InferSchemaInstanceType, AssignableProps, BuilderInitProps, IsNever } from "./types/HelperTypes.js";
import { CollectionSchema } from "./types/custom/CollectionSchema.js";
import { SetSchema } from "./types/custom/SetSchema.js";
import { StreamSchema } from "./types/custom/StreamSchema.js";
import { FieldBuilder, isBuilder, type BuilderDefinition } from "./types/builder.js";
import { dequantize, isQuantizedType, makeQuantizedEncoder, quantize, type QuantizeDescriptor } from "./types/quantize.js";

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
    | { type: T, default?: InferValueType<T>, view?: boolean | number, sync?: boolean }
    | { array: T, default?: ArraySchema<InferValueType<T>>, view?: boolean | number, sync?: boolean }
    | { map: T, default?: MapSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean }
    | { collection: T, default?: CollectionSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean }
    | { set: T, default?: SetSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean }
    | { stream: T, default?: StreamSchema<InferValueType<T>>, view?: boolean | number, sync?: boolean, priority?: (view: any, element: InferValueType<T>) => number };

export type Definition = { [field: string]: DefinitionType };

export interface TypeOptions {
    manual?: boolean,
}

export const DEFAULT_VIEW_TAG = -1;

/**
 * Class decorator that registers a `@type`-style Schema class with the
 * TypeContext (required for reflection / cross-language codegen).
 *
 *     @entity
 *     class Player extends Schema { ... }
 */
export function entity<T extends Function>(constructor: T): T {
    TypeContext.register(constructor as unknown as typeof Schema);
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
        const metadata = Metadata.initialize(target.constructor as typeof Schema);
        Metadata.setTag(metadata, fieldName, tag);
    }
}

/**
 * `@unreliable` — route a field onto the unreliable transport channel, so a
 * dropped update costs one stale value instead of stalling the ordered stream
 * behind a retransmit. Primitive fields only (see `Metadata.setUnreliable`).
 *
 * The field's FIRST value still travels the reliable channel, as part of the
 * owning instance's ADD; only later mutations become unreliable. A decoder
 * cannot apply a write to a ref it has not been told about, so a value emitted
 * ahead of that ADD would be dropped — and lost for good if the field is never
 * written again.
 */
export function unreliable<T> (target: T, field: string) {
    const metadata = Metadata.initialize(target.constructor as typeof Schema);
    Metadata.setUnreliable(metadata, field);
}

/**
 * @patchOnly — mark a field as not persisted to snapshots (encodeAll /
 * encodeAllView). PatchOnly fields are still emitted on per-tick patches
 * (reliable or unreliable), but late-joining clients won't see them until
 * the next mutation.
 *
 * Orthogonal to @unreliable: a field can be either, both, or neither.
 */
export function patchOnly<T> (target: T, field: string) {
    const metadata = Metadata.initialize(target.constructor as typeof Schema);
    Metadata.setPatchOnly(metadata, field);
}

/**
 * @fullStateOnly — mark a field as delivered in the full state sync only
 * (encodeAll / encodeAllView), never on per-tick patches. Writes after a
 * client has joined are not propagated to it — populate these fields
 * before clients connect (e.g. during onCreate).
 *
 * The exact mirror of @patchOnly — the two are mutually exclusive.
 */
export function fullStateOnly<T> (target: T, field: string) {
    const metadata = Metadata.initialize(target.constructor as typeof Schema);
    Metadata.setFullStateOnly(metadata, field);
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
            const { complexTypeKlass, childType } = resolveFieldType(type);

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

        // Pre-compute encoder function for primitive + quantized types.
        if (typeof type === "string" || isQuantizedType(type)) {
            if (!metadata[$encoders]) {
                Object.defineProperty(metadata, $encoders, {
                    value: [],
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            }
            metadata[$encoders][fieldIndex] = (typeof type === "string")
                ? (encode as any)[type]
                : makeQuantizedEncoder((type as any).quantized);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Per-field-shape specialized setters.
//
// Single shared closure used to handle all three shapes (primitive /
// schema-ref / collection) in one body with many branches. V8's inliner
// gave up on it because of the size + polymorphism. Splitting into three
// dedicated factories yields smaller, monomorphic bodies that the JIT can
// inline into hot setters like `position.x = 100`.
// ────────────────────────────────────────────────────────────────────────

/** typeof target per primitive type. Cached once, looked up O(1) at decoration. */
const PRIMITIVE_TYPEOF: Record<string, "number" | "string" | "boolean" | "bigint"> = {
    number: "number",
    int8: "number", uint8: "number",
    int16: "number", uint16: "number",
    int32: "number", uint32: "number",
    int64: "number", uint64: "number",
    float32: "number", float64: "number",
    bigint64: "bigint", biguint64: "bigint",
    string: "string",
    boolean: "boolean",
};

function makePrimitiveSetter(fieldName: string, fieldIndex: number, type: string) {
    const typeofTarget = PRIMITIVE_TYPEOF[type]; // undefined for custom types
    const allowNull = type === "string";
    const isBool = type === "boolean";
    return function (this: Schema, value: any) {
        const values = this[$values];
        const previousValue = values[fieldIndex];
        if (value === previousValue) return;

        if (value !== undefined && value !== null) {
            // Inlined assertType primitive check.
            if (
                !isBool &&
                typeofTarget !== undefined &&
                typeof value !== typeofTarget &&
                !(allowNull && value === null)
            ) {
                const ctorSuffix = (value && value.constructor) ? ` (${value.constructor.name})` : '';
                throw new EncodeSchemaError(
                    `a '${typeofTarget}' was expected, but '${JSON.stringify(value)}'${ctorSuffix} was provided in ${this.constructor.name}#${fieldName}`
                );
            }
            (this.constructor as typeof Schema)[$track](this[$changes], fieldIndex, OPERATION.ADD);
        } else if (previousValue !== undefined && previousValue !== null) {
            this[$changes].delete(fieldIndex);
        }
        values[fieldIndex] = value;
    };
}

function makeSchemaRefSetter(fieldName: string, fieldIndex: number, type: typeof Schema) {
    return function (this: Schema, value: any) {
        const values = this[$values];
        const previousValue = values[fieldIndex];
        if (value === previousValue) return;

        if (value !== undefined && value !== null) {
            assertInstanceType(value, type, this, fieldName);

            const changeTree = this[$changes];
            const ctor = this.constructor as typeof Schema;

            if (previousValue !== undefined && previousValue !== null && previousValue[$changes]) {
                changeTree.root?.remove(previousValue[$changes]);
                ctor[$track](changeTree, fieldIndex, OPERATION.DELETE_AND_ADD);
            } else {
                ctor[$track](changeTree, fieldIndex, OPERATION.ADD);
            }

            // External Schema-like instances may not carry a ChangeTree.
            value[$changes]?.setParent(this, changeTree.root, fieldIndex);

        } else if (previousValue !== undefined && previousValue !== null) {
            this[$changes].delete(fieldIndex);
        }
        values[fieldIndex] = value;
    };
}

function makeCollectionSetter(
    _fieldName: string,
    fieldIndex: number,
    type: DefinitionType,
    complexTypeKlass: TypeDefinition,
) {
    const isArrayKlass = complexTypeKlass.constructor === ArraySchema;
    const isMapKlass = complexTypeKlass.constructor === MapSchema;
    return function (this: Schema, value: any) {
        const values = this[$values];
        const previousValue = values[fieldIndex];
        if (value === previousValue) return;

        if (value !== undefined && value !== null) {
            // automatic Array → ArraySchema / Map → MapSchema conversion.
            // `$childType` goes on before populating — push()/set() gate
            // their `assertInstanceType` on it.
            if (isArrayKlass && !(value instanceof ArraySchema)) {
                const array: any = new ArraySchema();
                array[$childType] = type;
                array.push(...value);
                value = array;

            } else if (isMapKlass && !(value instanceof MapSchema)) {
                const map: any = new MapSchema();
                map[$childType] = type;
                if (value instanceof Map) {
                    value.forEach((v, k) => map.set(k, v));
                } else {
                    for (const k in value) { map.set(k, value[k]); }
                }
                value = map;

            } else {
                value[$childType] = type;
            }

            const changeTree = this[$changes];
            const ctor = this.constructor as typeof Schema;

            if (previousValue !== undefined && previousValue !== null && previousValue[$changes]) {
                changeTree.root?.remove(previousValue[$changes]);
                ctor[$track](changeTree, fieldIndex, OPERATION.DELETE_AND_ADD);
            } else {
                ctor[$track](changeTree, fieldIndex, OPERATION.ADD);
            }

            value[$changes]?.setParent(this, changeTree.root, fieldIndex);

        } else if (previousValue !== undefined && previousValue !== null) {
            this[$changes].delete(fieldIndex);
        }
        values[fieldIndex] = value;
    };
}

/**
 * Setter for a `t.quantized()` field. SNAPS the assigned float to the wire-exact
 * value (`dequant(quant(x))`) on write, so the stored value — and every read,
 * including the reconciler's live step off the staged input — is identical to
 * what the server decodes off the wire. This is the half that kills the
 * predict-from-the-wrong-value footgun; the encoder re-quantizes the snapped
 * value at send (a lossless round-trip). Change tracking keys on the SNAPPED
 * value, so a sub-step jitter that quantizes to the same integer emits no delta.
 */
function makeQuantizedSetter(fieldName: string, fieldIndex: number, desc: QuantizeDescriptor) {
    return function (this: Schema, value: any) {
        const values = this[$values];
        const previousValue = values[fieldIndex];
        if (value !== undefined && value !== null) {
            if (typeof value !== "number") {
                throw new EncodeSchemaError(
                    `a 'number' was expected, but '${JSON.stringify(value)}' was provided in ${this.constructor.name}#${fieldName}`
                );
            }
            value = dequantize(desc, quantize(desc, value)); // snap to wire-exact
            if (value === previousValue) return;
            (this.constructor as typeof Schema)[$track](this[$changes], fieldIndex, OPERATION.ADD);
        } else {
            if (value === previousValue) return; // undefined === undefined
            if (previousValue !== undefined && previousValue !== null) {
                this[$changes].delete(fieldIndex);
            }
        }
        values[fieldIndex] = value;
    };
}

export function getPropertyDescriptor(
    fieldName: string,
    fieldIndex: number,
    type: DefinitionType,
    complexTypeKlass: TypeDefinition | false,
) {
    let setter: (this: Schema, value: any) => void;
    if (complexTypeKlass) {
        setter = makeCollectionSetter(fieldName, fieldIndex, type, complexTypeKlass);
    } else if (typeof type === "string") {
        setter = makePrimitiveSetter(fieldName, fieldIndex, type);
    } else if (isQuantizedType(type)) {
        setter = makeQuantizedSetter(fieldName, fieldIndex, type.quantized);
    } else {
        setter = makeSchemaRefSetter(fieldName, fieldIndex, type as typeof Schema);
    }
    return {
        // Quantized stores the already-snapped float, so the getter is the plain
        // $values read — the field yields dequant(q) with no per-read math.
        get: function (this: Schema) { return this[$values][fieldIndex]; },
        set: setter,
        enumerable: true,
        configurable: true,
    };
}

/**
 * `@deprecated()` flag a field as deprecated.
 * The previous `@type()` annotation should remain along with this one.
 */

export function deprecated(throws: boolean = true): PropertyDecorator {
    return function (klass: typeof Schema, field: string) {
        const metadata = Metadata.initialize(klass.constructor as typeof Schema);
        Metadata.setDeprecated(metadata, field);

        if (throws) {
            metadata[$descriptors] ??= {};
            metadata[$descriptors][field] = {
                get: function () { throw new Error(`${field} is deprecated.`); },
                set: function (this: Schema, _value: any) { /* throw new Error(`${field} is deprecated.`); */ },
                enumerable: false,
                configurable: true
            };
            // Override accessor on the prototype so deprecated throws at access.
            Object.defineProperty(klass, field, metadata[$descriptors][field]);
        }
    }
}

let defineTypesWarned = false;

/**
 * Adds synchronizable fields to an existing `Schema` subclass — the pre-5.0
 * helper for plain JavaScript users.
 *
 * @deprecated Use `schema()` with `t.*` field builders instead:
 * https://docs.colyseus.io/state/schema
 */
export function defineTypes(
    target: typeof Schema,
    fields: Definition,
    options?: TypeOptions
) {
    if (!defineTypesWarned) {
        defineTypesWarned = true;
        console.warn("@colyseus/schema: defineTypes() is deprecated and will be removed in a future release. Use schema() with t.* field builders instead → https://docs.colyseus.io/state/schema");
    }
    for (let field in fields) {
        type(fields[field], options)(target.prototype, field);
    }
    return target;
}

// Helper type to extract InitProps from initialize method.
// - Non-empty initialize params: use them directly.
// - Zero-arg initialize: no args accepted (`never`) — user-supplied field
//   values would be dropped at runtime (parent's initialize is skipped
//   during child construction via the `new.target === klass` guard, and
//   own-field auto-assignment happens only inside initialize).
// - No initialize at all: derive from fields map.
type ExtractInitProps<T> = T extends { initialize: (...args: infer P) => void }
    ? P extends readonly []
        ? never
        : P extends readonly [infer First]
            ? First extends object
                ? First
                : P
            : P
    : BuilderInitProps<T>;

// Does the init-props shape have at least one required property?
type HasRequiredKeys<X> = {} extends X ? false : true;

// Whether the constructor's init-props argument must be supplied.
// Mirrors the cases inside ExtractInitProps: non-empty initialize params
// are required; zero-arg initialize accepts nothing; no initialize
// depends on whether the derived BuilderInitProps has any required keys.
type IsInitPropsRequired<T> = T extends { initialize: (...args: infer P) => void }
    ? P extends readonly []
        ? false
        : true
    : HasRequiredKeys<BuilderInitProps<T>>;

// Whether T declares any non-empty `initialize` method. Used to tighten
// the constructor signature: authors who write an explicit `initialize()`
// with args opt into strict required args. Without an initialize the sig
// also allows `[]` so the common `new X(); x.field = ...` pattern works.
type HasExplicitInit<T> = T extends { initialize: (...args: infer P) => void }
    ? P extends readonly [] ? false : true
    : false;

/**
 * A `schema()` field definition accepts a FieldBuilder, a Schema subclass
 * (shorthand for `t.ref(Class)`), or a method (attached to the prototype).
 */
export type FieldsAndMethods = Record<string, FieldBuilder<any, boolean, boolean> | (new (...args: any[]) => Schema) | Function>;

// One spelling for every site that names the instance — identical
// instantiations compare by identity, not structurally.
type SchemaInstance<T, P extends typeof Schema> = InferSchemaInstanceType<T> & InstanceType<P>;

export interface SchemaWithExtends<T, P extends typeof Schema> {
    extend: <T2 extends FieldsAndMethods = FieldsAndMethods>(
        fields: T2 & ThisType<SchemaInstance<T & T2, P>>,
        name?: string,
    ) => SchemaWithExtendsConstructor<T & T2, ExtractInitProps<T & T2>, P>;
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
    '~type': SchemaInstance<T, P>;
    // Constructor signature:
    //  - InitProps = never (zero-arg initialize): no args.
    //  - InitProps is a tuple (multi-arg initialize): spread it.
    //  - Explicit `initialize(arg)` with required args: strict [InitProps]
    //    — the author opted into requiring them.
    //  - No initialize, but required builder fields: allow `[]` or
    //    `[InitProps]`. Preserves `new X(); x.field = ...` while still
    //    flagging incomplete-object mistakes like `new X({ hp: 1 })`.
    //  - Otherwise: optional single-arg.
    new (...args:
        [InitProps] extends [never] ? []
        : InitProps extends readonly any[] ? InitProps
        : HasExplicitInit<T> extends true ? [InitProps]
        : IsInitPropsRequired<T> extends true ? ([] | [InitProps])
        : [InitProps?]
    ): SchemaInstance<T, P>;
    prototype: SchemaInstance<T, P> & {
        initialize(...args: [InitProps] extends [never] ? [] : InitProps extends readonly any[] ? InitProps : [InitProps]): void;
    };
}

/**
 * Build a per-construction factory for a builder type's auto-instantiated
 * default (empty collection or zero-arg Schema ref), or `undefined` when the
 * type has no auto-default. Returning a factory lets each construction `new` a
 * fresh value directly instead of cloning a shared prototype instance.
 */
function makeAutoDefaultFactory(rawType: any): (() => any) | undefined {
    if (rawType && typeof rawType === "object") {
        if (rawType.array !== undefined) { return () => new ArraySchema(); }
        if (rawType.map !== undefined) { return () => new MapSchema(); }
        if (rawType.set !== undefined) { return () => new SetSchema(); }
        if (rawType.collection !== undefined) { return () => new CollectionSchema(); }
        if (rawType.stream !== undefined) { return () => new StreamSchema(); }
    } else if (typeof rawType === "function" && Schema.is(rawType)) {
        if (!rawType.prototype.initialize || rawType.prototype.initialize.length === 0) {
            return () => new rawType();
        }
    }
    return undefined;
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
    fieldsAndMethods: T & ThisType<SchemaInstance<T, P>>,
    name?: string,
    inherits: P = Schema as P,
): SchemaWithExtendsConstructor<T, ExtractInitProps<T>, P> {
    if (fieldsAndMethods == null || typeof fieldsAndMethods !== "object") {
        throw new Error(`schema(): first argument must be a fields object (got ${typeof fieldsAndMethods}).`);
    }

    const fields: any = {};
    const methods: any = {};
    // Two buckets, both keyed by field name and applied at construction:
    //  - `defaultValues`: static values copied as-is (shared reference).
    //  - `defaultFactories`: invoked per construction for a fresh value —
    //    `.default(fn)`, clone-able defaults, and auto-instantiated collections/refs.
    const defaultValues: any = {};
    const defaultFactories: { [field: string]: () => any } = {};

    // Decide once (at definition time) how each `.default(v)` materializes per
    // construction: a function is a factory; a clone-able value clones fresh;
    // anything else is a shared static value.
    const assignDefault = (field: string, value: any) => {
        if (typeof value === "function") {
            defaultFactories[field] = value;
        } else if (value && typeof value.clone === "function") {
            defaultFactories[field] = () => value.clone();
        } else {
            defaultValues[field] = value;
        }
    };

    // Seed a field's construction default: explicit `.default(v)`, else the
    // auto-instantiated empty collection / zero-arg ref (skipped for `.optional()`).
    const seedDefault = (field: string, def: BuilderDefinition) => {
        if (def.hasDefault) {
            assignDefault(field, def.default);
        } else if (!def.optional) {
            const factory = makeAutoDefaultFactory(def.type);
            if (factory) { defaultFactories[field] = factory; }
        }
    };

    const viewTagFields: { [field: string]: number } = {};
    const unreliableFields: string[] = [];
    const patchOnlyFields: string[] = [];
    const deprecatedFields: { [field: string]: boolean } = {};
    const fullStateOnlyFields: string[] = [];
    const streamFields: string[] = [];
    const streamPriorityFields: { [field: string]: (view: any, element: any) => number } = {};
    const optionalFields: string[] = [];

    for (const fieldName in fieldsAndMethods) {
        const value: any = (fieldsAndMethods as any)[fieldName];

        if (isBuilder(value)) {
            const def = value['toDefinition'](); // private; element access bypasses visibility

            if (def.noSync) {
                // Local-only field: skip metadata registration entirely so it is
                // never encoded/decoded, but still seed its construction default
                // (honoring `.default()` and collection/ref auto-instantiation).
                if (def.view !== undefined || def.unreliable ||
                    def.patchOnly || def.fullStateOnly || def.stream) {
                    throw new Error(
                        `schema(${name ? `'${name}'` : ""}): field '${fieldName}' uses .noSync() ` +
                        `together with a sync-only modifier (.view/.unreliable/.patchOnly/.fullStateOnly/.stream). ` +
                        `A local-only field cannot be synchronized.`
                    );
                }
                seedDefault(fieldName, def);
                continue;
            }

            // The two delivery channels are exhaustive: excluding a field from
            // both leaves it with nowhere to go — a silent .noSync().
            if (def.patchOnly && def.fullStateOnly) {
                throw new Error(
                    `schema(${name ? `'${name}'` : ""}): field '${fieldName}' uses .patchOnly() ` +
                    `together with .fullStateOnly(). Those are the only two delivery channels, ` +
                    `so the field would never reach a client — use .noSync() if that is intended.`
                );
            }

            const normalizedType = getNormalizedType(def.type);
            // A synced ref must be encodable (a Schema, or Metadata.setFields()'d) — reject a bare class.
            if (typeof normalizedType === "function" && !Schema.is(normalizedType)) {
                throw new Error(
                    `schema(${name ? `'${name}'` : ""}): field '${fieldName}' is a synced ref to non-Schema ` +
                    `class '${normalizedType.name || "(anonymous)"}' — use .noSync(), or Metadata.setFields().`
                );
            }
            fields[fieldName] = normalizedType;

            if (def.view !== undefined) { viewTagFields[fieldName] = def.view; }
            if (def.unreliable) { unreliableFields.push(fieldName); }
            if (def.patchOnly) { patchOnlyFields.push(fieldName); }
            if (def.deprecated) { deprecatedFields[fieldName] = def.deprecatedThrows; }
            if (def.fullStateOnly) { fullStateOnlyFields.push(fieldName); }
            if (def.stream) { streamFields.push(fieldName); }
            if (def.streamPriority !== undefined) { streamPriorityFields[fieldName] = def.streamPriority; }
            if (def.optional) { optionalFields.push(fieldName); }

            seedDefault(fieldName, def);

        } else if (typeof value === "function") {
            if (Schema.is(value)) {
                // Convenience: allow a bare Schema subclass (equivalent to `t.ref(Class)`).
                fields[fieldName] = getNormalizedType(value);
                if (!value.prototype.initialize || value.prototype.initialize.length === 0) {
                    defaultFactories[fieldName] = () => new (value as any)();
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

    // Write construction defaults onto `target` — either the instance directly
    // (no-args fast path) or a throwaway object that gets merged with props.
    const applyDefaults = (target: any) => {
        for (const fieldName in defaultValues) {
            target[fieldName] = defaultValues[fieldName];
        }
        for (const fieldName in defaultFactories) {
            target[fieldName] = defaultFactories[fieldName]();
        }
    };

    const getDefaultValues = () => {
        const defaults: any = {};
        applyDefaults(defaults);
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

    const hasInitialize = typeof methods.initialize === "function";

    /** @codegen-ignore */
    const klass = Metadata.setFields<any>(class extends (inherits as any) {
        constructor(...args: any[]) {
            const props = args[0];
            if (props === undefined) {
                // No-args: write defaults straight onto the instance — skips the
                // throwaway defaults object + Object.assign + assignProps walk.
                super();
                applyDefaults(this);
            } else {
                // With props: merge into the fresh defaults object in place (no
                // extra `{}` target); the super chain runs assignProps once. An
                // `initialize()` owns the schema fields, so only parent props flow up.
                super(Object.assign(getDefaultValues(), hasInitialize ? getParentProps(props) : props));
            }
            // Only call initialize() on the exact target class, not parents.
            if (hasInitialize && new.target === klass) {
                methods.initialize.apply(this, args);
            }
        }
    }, fields) as unknown as SchemaWithExtendsConstructor<T, ExtractInitProps<T>, P>;

    (klass as any)._getDefaultValues = getDefaultValues;

    Object.assign(klass.prototype, methods);

    for (const fieldName in viewTagFields) {
        view(viewTagFields[fieldName])(klass.prototype, fieldName);
    }
    for (const fieldName of unreliableFields) {
        unreliable(klass.prototype, fieldName);
    }
    for (const fieldName of patchOnlyFields) {
        patchOnly(klass.prototype, fieldName);
    }
    for (const fieldName in deprecatedFields) {
        deprecated(deprecatedFields[fieldName])(klass.prototype, fieldName);
    }

    if (fullStateOnlyFields.length > 0 || streamFields.length > 0) {
        const metadata = (klass as any)[Symbol.metadata] as Metadata;
        for (const fieldName of fullStateOnlyFields) {
            Metadata.setFullStateOnly(metadata, fieldName);
        }
        for (const fieldName of streamFields) {
            Metadata.setStream(metadata, fieldName);
        }
        for (const fieldName in streamPriorityFields) {
            Metadata.setStreamPriority(metadata, fieldName, streamPriorityFields[fieldName]);
        }
    }

    if (optionalFields.length > 0) {
        const metadata = (klass as any)[Symbol.metadata] as Metadata;
        for (const fieldName of optionalFields) {
            metadata[metadata[fieldName]].optional = true;
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
