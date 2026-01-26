import type { Definition, DefinitionType, PrimitiveType, RawPrimitiveType } from "../annotations.js";
import type { Schema } from "../Schema.js";
import type { ArraySchema } from "./custom/ArraySchema.js";
import type { CollectionSchema } from "./custom/CollectionSchema.js";
import type { MapSchema } from "./custom/MapSchema.js";
import type { SetSchema } from "./custom/SetSchema.js";

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

export type InferValueType<T extends DefinitionType> =
    T extends "string" ? string
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

    // Handle direct types
    : T extends Constructor ? InstanceType<T>
    : T extends Record<string | number, string | number> ? T[keyof T] // TS ENUM
    : T extends PrimitiveType ? T

    : never;

export type InferSchemaInstanceType<T extends Definition> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any
        ? (T[K] extends new (...args: any[]) => any ? InferValueType<T[K]> : T[K])
        : InferValueType<T[K]>
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

export type ToJSON<T> = NonFunctionProps<{
    [K in keyof T]:
        T[K] extends MapSchema<infer U> ? Record<string, ToJSONValue<U>>
        : T[K] extends Map<string, infer U> ? Record<string, ToJSONValue<U>>
        : T[K] extends ArraySchema<infer U> ? ToJSONValue<U>[]
        : T[K] extends SetSchema<infer U> ? ToJSONValue<U>[]
        : T[K] extends CollectionSchema<infer U> ? ToJSONValue<U>[]
        : T[K] extends Schema ? ToJSON<T[K]>
        : T[K]
}>;

// Helper type to check if T is exactly 'never' (meaning no InitProps was provided)
export type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Type helper for .assign() method - allows assigning values in a flexible way
 * - Primitives can be assigned directly
 * - Schema instances can be assigned from plain objects or Schema instances
 * - Collections can be assigned from their JSON representations
 */
export type AssignableProps<T> = {
    [K in NonFunctionPropNames<T>]?: T[K] extends MapSchema<infer U>
        ? MapSchema<U> | Record<string, U extends Schema ? (U | AssignableProps<U>) : U>
        : T[K] extends ArraySchema<infer U>
            ? ArraySchema<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
            : T[K] extends SetSchema<infer U>
                ? SetSchema<U> | Set<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
                : T[K] extends CollectionSchema<infer U>
                    ? CollectionSchema<U> | (U extends Schema ? (U | AssignableProps<U>)[] : U[])
                    : T[K] extends Schema
                        ? T[K] | AssignableProps<T[K]>
                        : T[K]
};