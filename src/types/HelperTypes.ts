import type { Definition, DefinitionType, PrimitiveType, RawPrimitiveType } from "../annotations.js";
import type { Schema } from "../Schema.js";
import type { ArraySchema } from "./custom/ArraySchema.js";
import type { CollectionSchema } from "./custom/CollectionSchema.js";
import type { MapSchema } from "./custom/MapSchema.js";
import type { SetSchema } from "./custom/SetSchema.js";
import type { StreamSchema } from "./custom/StreamSchema.js";
import type { FieldBuilder } from "./builder.js";

export type Constructor<T = {}> = new (...args: any[]) => T;

// Helper to convert primitive type literals to actual runtime types
type PrimitiveStringToType<T> =
    T extends "string" ? string
    : T extends "number" | "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "int64" | "uint64" | "float32" | "float64" ? number
    : T extends "boolean" ? boolean
    : T;

export interface Collection<K = any, V = any, IT = V> {
    [Symbol.iterator](): IterableIterator<IT>;
    forEach(callback: Function): void;
    entries(): IterableIterator<[K, V]>;
}

export type InferValueType<T> =
    // FieldBuilder<V> unwraps to V (used by the zod-style schema() API)
    T extends FieldBuilder<infer V> ? V

    : T extends "string" ? string
    : T extends "number" ? number
    : T extends "int8" ? number
    : T extends "uint8" ? number
    : T extends "int16" ? number
    : T extends "uint16" ? number
    : T extends "int32" ? number
    : T extends "uint32" ? number
    : T extends "int64" ? number
    : T extends "uint64" ? number
    : T extends "float32" ? number
    : T extends "float64" ? number
    : T extends "boolean" ? boolean

    // Handle { type: ... } patterns
    : T extends { type: infer ChildType extends PrimitiveType } ? InferValueType<ChildType>
    : T extends { type: infer ChildType extends Constructor } ? InstanceType<ChildType>
    : T extends { type: Array<infer ChildType> } ? (ChildType extends Record<string | number, string | number> ? ChildType[keyof ChildType][] : ChildType[]) // TS ENUM
    : T extends { type: { map: infer ChildType } } ? (ChildType extends Record<string | number, string | number> ? MapSchema<ChildType[keyof ChildType]> : MapSchema<ChildType>) // TS ENUM
    : T extends { type: { set: infer ChildType } } ? (ChildType extends Record<string | number, string | number> ? SetSchema<ChildType[keyof ChildType]> : SetSchema<ChildType>) // TS ENUM
    : T extends { type: { collection: infer ChildType } } ? (ChildType extends Record<string | number, string | number> ? CollectionSchema<ChildType[keyof ChildType]> : CollectionSchema<ChildType>) // TS ENUM
    : T extends { type: { stream: infer ChildType extends Constructor } } ? StreamSchema<InstanceType<ChildType>>
    : T extends { type: { stream: infer ChildType } } ? StreamSchema<ChildType>
    : T extends { type: infer ChildType } ? (ChildType extends Record<string | number, string | number> ? ChildType[keyof ChildType] : ChildType) // TS ENUM

    // Handle direct array patterns
    : T extends Array<infer ChildType extends Constructor> ? ArraySchema<InstanceType<ChildType>>
    : T extends Array<infer ChildType> ? (ChildType extends Record<string | number, string | number> ? ArraySchema<ChildType[keyof ChildType]> : ArraySchema<PrimitiveStringToType<ChildType>>) // TS ENUM

    // Handle collection object patterns
    : T extends { array: infer ChildType extends Constructor } ? ArraySchema<InstanceType<ChildType>>
    : T extends { array: infer ChildType } ? (ChildType extends Record<string | number, string | number> ? ArraySchema<ChildType[keyof ChildType]> : ArraySchema<PrimitiveStringToType<ChildType>>) // TS ENUM

    : T extends { map: infer ChildType extends Constructor } ? MapSchema<InstanceType<ChildType>>
    : T extends { map: infer ChildType } ? (ChildType extends Record<string | number, string | number> ? MapSchema<ChildType[keyof ChildType]> : MapSchema<PrimitiveStringToType<ChildType>>) // TS ENUM

    : T extends { set: infer ChildType extends Constructor } ? SetSchema<InstanceType<ChildType>>
    : T extends { set: infer ChildType extends RawPrimitiveType } ? SetSchema<InferValueType<ChildType>> // primitive types
    : T extends { set: infer ChildType } ? (ChildType extends Record<string | number, string | number> ? SetSchema<ChildType[keyof ChildType]> : SetSchema<ChildType>) // TS ENUM

    : T extends { collection: infer ChildType extends Constructor } ? CollectionSchema<InstanceType<ChildType>>
    : T extends { collection: infer ChildType extends RawPrimitiveType } ? CollectionSchema<InferValueType<ChildType>> // primitive types
    : T extends { collection: infer ChildType } ? (ChildType extends Record<string | number, string | number> ? CollectionSchema<ChildType[keyof ChildType]> : CollectionSchema<ChildType>) // TS ENUM

    : T extends { stream: infer ChildType extends Constructor } ? StreamSchema<InstanceType<ChildType>>
    : T extends { stream: infer ChildType } ? StreamSchema<ChildType>

    // Handle direct types
    : T extends Constructor ? InstanceType<T>
    : T extends Record<string | number, string | number> ? T[keyof T] // TS ENUM
    : T extends PrimitiveType ? T

    : never;

// Keys whose FieldBuilder generic admits `undefined` (i.e. `.optional()` was chained).
type OptionalBuilderKeys<T> = {
    [K in keyof T]: T[K] extends FieldBuilder<infer V>
        ? (undefined extends V ? K : never)
        : never
}[keyof T];

type RequiredBuilderKeys<T> = Exclude<keyof T, OptionalBuilderKeys<T>>;

export type InferSchemaInstanceType<T> = {
    [K in RequiredBuilderKeys<T>]: T[K] extends FieldBuilder<any>
        ? InferValueType<T[K]>
        : T[K] extends (...args: any[]) => any
            ? (T[K] extends new (...args: any[]) => any ? InferValueType<T[K]> : T[K])
            : InferValueType<T[K]>
} & {
    [K in OptionalBuilderKeys<T>]?: T[K] extends FieldBuilder<infer V>
        ? V
        : never
} & Schema;

export type NonFunctionProps<T> = Omit<T, {
    [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T]>;

export type NonFunctionPropNames<T> = {
    [K in keyof T]: T[K] extends Function ? never : K
}[keyof T];

export type NonFunctionNonPrimitivePropNames<T> = {
    [K in keyof T]: T[K] extends Function
        ? never
        : T[K] extends number | string | boolean
            ? never
            : K
}[keyof T];

// Helper to recursively convert Schema instances to their JSON representation
type ToJSONValue<U> = U extends Schema ? ToJSON<U> : PrimitiveStringToType<U>;

type ToJSONField<X> =
    X extends MapSchema<infer U> ? Record<string, ToJSONValue<U>>
    : X extends Map<string, infer U> ? Record<string, ToJSONValue<U>>
    : X extends ArraySchema<infer U> ? ToJSONValue<U>[]
    : X extends SetSchema<infer U> ? ToJSONValue<U>[]
    : X extends CollectionSchema<infer U> ? ToJSONValue<U>[]
    : X extends Schema ? ToJSON<X>
    : X;

// Keys whose value type admits `undefined` — runtime `toJSON()` omits those,
// so they surface as `?:` on the JSON shape.
type ToJSONRequiredKeys<T> = {
    [K in keyof T]-?: undefined extends T[K] ? never : K
}[keyof T];
type ToJSONOptionalKeys<T> = {
    [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T];

export type ToJSON<T> = NonFunctionProps<
    & { [K in ToJSONRequiredKeys<T>]: ToJSONField<T[K]> }
    & { [K in ToJSONOptionalKeys<T>]?: ToJSONField<Exclude<T[K], undefined>> }
>;

// Helper type to check if T is exactly 'never' (meaning no InitProps was provided)
export type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Type helper for .assign() method - allows assigning values in a flexible way
 * - Primitives can be assigned directly
 * - Schema instances can be assigned from plain objects or Schema instances
 * - Collections can be assigned from their JSON representations
 */
export type AssignableProps<T> = {
    [K in NonFunctionPropNames<T>]?: AssignableValue<T[K]>
};

/**
 * Value-level assignment shape shared by `AssignableProps` and
 * `BuilderInitProps`. Captures the "you can pass the real instance, or the
 * plain-object / array shape" pattern.
 */
export type AssignableValue<V> =
    V extends MapSchema<infer U>
        ? MapSchema<U> | Record<string, U extends Schema ? (U | AssignableProps<U>) : U>
        : V extends ArraySchema<infer U>
            ? ArraySchema<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
            : V extends SetSchema<infer U>
                ? SetSchema<U> | Set<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
                : V extends CollectionSchema<infer U>
                    ? CollectionSchema<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
                    : V extends Schema
                        ? V | AssignableProps<V>
                        : V;

// ---------------------------------------------------------------------------
// BuilderInitProps<T> — init-props shape derived from a schema() fields map.
// Unlike AssignableProps (fully partial, for `.assign()` updates), this type
// enforces required vs optional based on per-field `HasDefault` + `undefined`.
// ---------------------------------------------------------------------------

// Compile-time analogue of schema()'s Schema-ref auto-default rule:
// if the ref has no `initialize`, or a zero-arg `initialize`, schema()
// auto-instantiates it — so the field is omittable at construction.
export type RefHasDefault<C> =
    C extends { prototype: { initialize(...args: infer P): any } }
        ? (P extends readonly [] ? true : false)
        : true;

// Resolve a fields-map entry to its runtime value type.
type FieldValue<F> =
    F extends FieldBuilder<infer V, boolean, boolean> ? V
    : F extends new (...args: any[]) => infer I ? (I extends Schema ? I : never)
    : never;

// Classify each key of a fields map as "required" / "optional" / "none"
// (methods). Both `HasDefault = true` and the explicit `.optional()` brand
// `IsOptional = true` mark the field omittable at construction. The brand
// sidesteps a TypeScript quirk where `undefined extends V` returned `true`
// for non-undefined V when V was inferred from a class with T in
// contravariant + covariant positions.
type KeyClass<T, K extends keyof T> =
    T[K] extends FieldBuilder<unknown, infer D extends boolean, infer O extends boolean>
        ? (D extends true
            ? "optional"
            : O extends true ? "optional" : "required")
        : T[K] extends new (...args: any[]) => Schema
            ? (RefHasDefault<T[K]> extends true ? "optional" : "required")
            : "none";

export type BuilderRequiredKeys<T> = {
    [K in keyof T]-?: KeyClass<T, K> extends "required" ? K : never
}[keyof T];

export type BuilderOptionalKeys<T> = {
    [K in keyof T]-?: KeyClass<T, K> extends "optional" ? K : never
}[keyof T];

/**
 * Constructor/init-props type for a schema() fields map. Required fields
 * (primitives without `.default()` or `.optional()`, and Schema refs with
 * non-zero-arg `initialize()`) are `:`; everything else is `?:`.
 */
export type BuilderInitProps<T> =
    & { [K in BuilderRequiredKeys<T>]: AssignableValue<FieldValue<T[K]>> }
    & { [K in BuilderOptionalKeys<T>]?: AssignableValue<Exclude<FieldValue<T[K]>, undefined>> };