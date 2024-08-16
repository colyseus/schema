import { ArraySchema } from "./custom/ArraySchema";
import { MapSchema } from "./custom/MapSchema";

export interface Collection<K = any, V = any, IT = V> {
    [Symbol.iterator](): IterableIterator<IT>;
    forEach(callback: Function);
    entries(): IterableIterator<[K, V]>;
}

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