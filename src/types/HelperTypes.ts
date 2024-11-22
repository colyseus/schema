import type { Definition, PrimitiveType } from "../annotations";
import type { Schema } from "../Schema";
import type { ArraySchema } from "./custom/ArraySchema";
import type { CollectionSchema } from "./custom/CollectionSchema";
import type { MapSchema } from "./custom/MapSchema";
import type { SetSchema } from "./custom/SetSchema";

export interface Collection<K = any, V = any, IT = V> {
    [Symbol.iterator](): IterableIterator<IT>;
    forEach(callback: Function);
    entries(): IterableIterator<[K, V]>;
}

export type InferSchemaType<T extends Definition> = {
    [K in keyof T]:
      T[K] extends "string" ? string
    : T[K] extends "number" ? number
    : T[K] extends "int8" ? number
    : T[K] extends "uint8" ? number
    : T[K] extends "int16" ? number
    : T[K] extends "uint16" ? number
    : T[K] extends "int32" ? number
    : T[K] extends "uint32" ? number
    : T[K] extends "int64" ? number
    : T[K] extends "uint64" ? number
    : T[K] extends "float32" ? number
    : T[K] extends "float64" ? number
    : T[K] extends "boolean" ? boolean
    : T[K] extends Array<infer ChildType extends PrimitiveType> ? ChildType[]
    : T[K] extends { array: infer ChildType extends PrimitiveType } ? ChildType[]
    : T[K] extends { map: infer ChildType extends PrimitiveType } ? MapSchema<ChildType>
    : T[K] extends { set: infer ChildType extends PrimitiveType } ? SetSchema<ChildType>
    : T[K] extends { collection: infer ChildType extends PrimitiveType } ? CollectionSchema<ChildType>
    : T[K] extends PrimitiveType ? T[K]
    : never
} & Schema;

export type DefinedSchemaType<T extends Definition> = (new () => InferSchemaType<T>) & typeof Schema;

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

export type ToJSON<T> = NonFunctionProps<{
    [K in keyof T]: T[K] extends MapSchema<infer U>
        ? Record<string, U>
        : T[K] extends Map<string, infer U>
            ? Record<string, U>
            : T[K] extends ArraySchema<infer U>
                ? U[]
                : T[K]
}>;