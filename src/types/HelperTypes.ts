import type { Definition, DefinitionType, PrimitiveType, RawPrimitiveType } from "../annotations";
import type { Schema } from "../Schema";
import type { ArraySchema } from "./custom/ArraySchema";
import type { CollectionSchema } from "./custom/CollectionSchema";
import type { MapSchema } from "./custom/MapSchema";
import type { SetSchema } from "./custom/SetSchema";

export type Constructor<T = {}> = new (...args: any[]) => T;

export interface Collection<K = any, V = any, IT = V> {
    [Symbol.iterator](): IterableIterator<IT>;
    forEach(callback: Function);
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

    : T extends { type: infer ChildType extends Constructor } ? InstanceType<ChildType>
    : T extends { type: infer ChildType extends PrimitiveType } ? ChildType

    : T extends Array<infer ChildType extends Constructor> ? InstanceType<ChildType>[]
    : T extends Array<infer ChildType extends RawPrimitiveType> ? ChildType[]

    : T extends { array: infer ChildType extends Constructor } ? InstanceType<ChildType>[]
    : T extends { array: infer ChildType extends PrimitiveType } ? ChildType[]

    : T extends { map: infer ChildType extends Constructor } ? MapSchema<InstanceType<ChildType>>
    : T extends { map: infer ChildType extends PrimitiveType } ? MapSchema<ChildType>

    : T extends { set: infer ChildType extends Constructor } ? SetSchema<InstanceType<ChildType>>
    : T extends { set: infer ChildType extends PrimitiveType } ? SetSchema<ChildType>

    : T extends { collection: infer ChildType extends Constructor } ? CollectionSchema<InstanceType<ChildType>>
    : T extends { collection: infer ChildType extends PrimitiveType } ? CollectionSchema<ChildType>

    : T extends Constructor ? InstanceType<T>
    : T extends PrimitiveType ? T

    : never;

export type InferSchemaInstanceType<T extends Definition> = {
    [K in keyof T]: InferValueType<T[K]>
} & Schema;

export type DefinedSchemaType<T extends Definition, P extends typeof Schema> = {
    new (): InferSchemaInstanceType<T> & InstanceType<P>;
} & typeof Schema;

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