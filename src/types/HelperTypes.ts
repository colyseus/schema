import { $resyncPrune } from "./symbols.js";
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
    : T extends "bigint64" | "biguint64" ? bigint
    : T extends "boolean" ? boolean
    : T;

/**
 * What the decoder callbacks accept as "a collection": the public shape, which
 * a plain array satisfies too — `@type([X]) items: X[]` is a common way to
 * declare a field. {@link Collection} is the runtime contract on top of it.
 */
export interface CollectionLike<K = any, V = any, IT = V> {
    [Symbol.iterator](): IterableIterator<IT>;
    forEach(callback: Function): void;
    entries(): IterableIterator<[K, V]>;
}

export interface Collection<K = any, V = any, IT = V> extends CollectionLike<K, V, IT> {
    /** See {@link $resyncPrune} — every collection kind must declare its resync-sweep semantics. */
    [$resyncPrune](
        visited: Set<number | string>,
        prune: (value: V, identity: number | string) => void,
        keep: (value: V) => void,
    ): void;
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
    : T extends "bigint64" ? bigint
    : T extends "biguint64" ? bigint
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

/**
 * Codecs that can carry a `T` — {@link InferValueType} run backwards, derived
 * from it so the two can't drift. Constrains the element refinement in
 * `t.array<Mark>("uint8")`; `never` (an uncallable overload) when no codec
 * decodes into `T`.
 *
 * `[T] extends [...]` is deliberate: a distributive check would let a mixed
 * union like `string | number` match on either half.
 */
export type CodecFor<T> = {
    [K in RawPrimitiveType]: [T] extends [InferValueType<K>] ? K : never
}[RawPrimitiveType];

// Keys whose builder carries the `.optional()` brand. Reads the brand rather
// than `undefined extends V`: the latter is true for EVERY V when the consumer
// compiles with `strictNullChecks: false`, flipping all fields optional.
type IsOptionalBuilderKey<T, K extends keyof T> =
    T[K] extends FieldBuilder<unknown, boolean, infer O extends boolean> ? O : false;

// THE RULE for every mapped type below that projects a user's declared fields:
// split in the `as` clause, never over a precomputed key union. Only a
// homomorphic mapping carries each key back to its declaration, and that link
// is what go-to-definition and rename resolve through — losing it leaves rename
// silently touching just the cursor (colyseus/colyseus#958). The `-readonly`
// and `-?` that follow drop the modifiers such a mapping inherits from `T`.
export type InferSchemaInstanceType<T> = {
    -readonly [K in keyof T as IsOptionalBuilderKey<T, K> extends true ? never : K]-?: T[K] extends FieldBuilder<any>
        ? InferValueType<T[K]>
        : T[K] extends (...args: any[]) => any
            ? (T[K] extends new (...args: any[]) => any ? InferValueType<T[K]> : T[K])
            : InferValueType<T[K]>
} & {
    -readonly [K in keyof T as IsOptionalBuilderKey<T, K> extends true ? K : never]?: T[K] extends FieldBuilder<infer V>
        ? V
        : never
} & Schema;

// Per-key filter, never `Omit`/`Exclude` over the union of method names: with
// one field typed by a bare type parameter that union defers EVERY key, and a
// mapped type with no resolvable keys has no members to relate — which is what
// stopped `SpecialNode<E>` from satisfying `extends NodeBase`.
// `keyof Schema` is dropped so `restore({ ... })` takes a plain literal.
type DataKey<T, K extends keyof T> =
    K extends keyof Schema ? never
    : T[K] extends Function ? never
    : K;

export type NonFunctionPropNames<T> = { [K in keyof T]-?: DataKey<T, K> }[keyof T];

export type NonFunctionNonPrimitivePropNames<T> = {
    [K in keyof T]-?: [DataKey<T, K>] extends [never] ? never : T[K] extends number | string | boolean ? never : K
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

// Runtime `toJSON()` omits `undefined` values, so those keys surface as `?:`.
// Under `strictNullChecks: false` (`undefined extends {}` detects it)
// `undefined extends T[K]` is true for every key, so only the `?` modifier
// can signal optionality there.
type IsOptionalKey<T, K extends keyof T> = undefined extends {}
    ? ({} extends Pick<T, K> ? true : false)
    : (undefined extends T[K] ? true : false);

// Beyond THE RULE, the `as` clause is load-bearing here for a second reason: it
// runs before the value type, so `ToJSONField` never reaches the machinery,
// where it would recurse through `restore(json: ToJSON<this>)` past TypeScript
// 7's instantiation limit. Probing `IsOptionalKey` first is deliberate too —
// `DataKey` then runs in the taken branch only, once per key not once per half.
export type ToJSON<T> =
    & { -readonly [K in keyof T as IsOptionalKey<T, K> extends true ? never : DataKey<T, K>]-?: ToJSONField<T[K]> }
    & { -readonly [K in keyof T as IsOptionalKey<T, K> extends true ? DataKey<T, K> : never]?: ToJSONField<Exclude<T[K], undefined>> };

/**
 * The plain DATA shape of a Schema instance type `T`: its synchronized fields
 * with all `Schema` machinery stripped (`assign`, `clone`, `toJSON`, the
 * change-tracking state, the internal symbol keys, …), so a plain object literal
 * satisfies it. Field types — including narrowed primitives like
 * `t.int8<-1 | 0 | 1>()` — are preserved exactly.
 *
 * Use it to type code that operates on schema-shaped *plain objects* rather than
 * decoded instances: deterministic simulation / physics steps, synthesized or
 * buffered input commands, plain DTOs, etc.
 *
 * ```ts
 * function applyInput(state: Player, cmd: Data<MoveInput>) { … }
 * applyInput(player, { moveX: 1, jump: false, dt });   // plain literal — OK
 * ```
 *
 * Unlike {@link ToJSON} (a recursive *serialization* shape), this is a flat
 * structural projection: nested Schema / collection fields keep their instance
 * types.
 */
export type Data<T> = Omit<T, keyof Schema>;

// Helper type to check if T is exactly 'never' (meaning no InitProps was provided)
export type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Type helper for .assign() method - allows assigning values in a flexible way
 * - Primitives can be assigned directly
 * - Schema instances can be assigned from plain objects or Schema instances
 * - Collections can be assigned from their JSON representations
 *
 * Keys filter through `DataKey` in the `as` clause — see THE RULE above.
 */
export type AssignableProps<T> = {
    -readonly [K in keyof T as DataKey<T, K>]?: AssignableValue<T[K]>
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
// `IsOptional = true` mark the field omittable at construction. Reading the
// brands (never `undefined extends V`) keeps this correct for consumers on
// `strictNullChecks: false`, where `undefined extends V` is true for every V.
type KeyClass<T, K extends keyof T> =
    T[K] extends FieldBuilder<unknown, infer D extends boolean, infer O extends boolean>
        ? (D extends true
            ? "optional"
            : O extends true ? "optional" : "required")
        : T[K] extends new (...args: any[]) => Schema
            ? (RefHasDefault<T[K]> extends true ? "optional" : "required")
            : "none";

/**
 * Constructor/init-props type for a schema() fields map. Required fields
 * (primitives without `.default()` or `.optional()`, and Schema refs with
 * non-zero-arg `initialize()`) are `:`; everything else is `?:`.
 *
 * Split by `KeyClass` in the `as` clause — see THE RULE above. `-?` matters
 * under `strictNullChecks: false`: an optional key in the fields map still
 * classifies as "required" there, and would otherwise inherit the `?`.
 */
export type BuilderInitProps<T> =
    & { -readonly [K in keyof T as KeyClass<T, K> extends "required" ? K : never]-?: AssignableValue<FieldValue<T[K]>> }
    & { -readonly [K in keyof T as KeyClass<T, K> extends "optional" ? K : never]?: AssignableValue<Exclude<FieldValue<T[K]>, undefined>> };