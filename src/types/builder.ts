import type { ArraySchema } from "./custom/ArraySchema.js";
import type { MapSchema } from "./custom/MapSchema.js";
import type { SetSchema } from "./custom/SetSchema.js";
import type { CollectionSchema } from "./custom/CollectionSchema.js";
import type { StreamSchema } from "./custom/StreamSchema.js";
import type { Schema } from "../Schema.js";
import type { DefinitionType, RawPrimitiveType } from "../annotations.js";
import type { InferValueType, Constructor } from "./HelperTypes.js";
import { $builder } from "./symbols.js";
import { ARRAY_STREAM_NOT_SUPPORTED } from "../encoder/streaming.js";

type CollectionKind = "array" | "map" | "set" | "collection";

/**
 * Internal record produced by FieldBuilder#toDefinition() and consumed by schema().
 */
export interface BuilderDefinition {
    type: DefinitionType;
    default?: any;
    hasDefault: boolean;
    view?: number;    // tag value; undefined = no view
    owned?: boolean;
    unreliable?: boolean;
    transient?: boolean;
    deprecated?: boolean;
    deprecatedThrows?: boolean;
    static?: boolean;
    stream?: boolean;
    optional?: boolean;
    /** Declaration-scope priority callback for `.stream()` fields. */
    streamPriority?: (view: any, element: any) => number;
}

/**
 * Type-function that infers the instance value for a builder.
 */
export type BuilderOf<T> = FieldBuilder<T>;

/**
 * Chainable field builder. Instances are produced by `t.*()` factories.
 *
 * Generics:
 *  - `T` is the runtime/JS type of the field (e.g. `number`, `string`,
 *    `ArraySchema<Item>`). `.optional()` widens it to `T | undefined`
 *    so the inferred instance/toJSON shapes reflect absence.
 *  - `HasDefault` is a compile-time flag that the field carries a
 *    construction-time default — either an explicit `.default(v)` or an
 *    auto-default from a collection factory (`t.array`, `t.map`, …) or a
 *    Schema ref whose `initialize` takes zero args.
 *  - `IsOptional` is a compile-time brand for `.optional()`. Both
 *    `HasDefault` and `IsOptional` make the field omittable in
 *    `BuilderInitProps<T>`. A separate brand (rather than reading
 *    `undefined extends V`) sidesteps a TypeScript quirk where
 *    class-generic-inferred `V` resolves `undefined extends V` as `true`
 *    even for non-undefined types.
 *
 * schema() reads the internal configuration via `toDefinition()` and wires
 * up metadata through the existing pipeline.
 */
export class FieldBuilder<
    T = unknown,
    HasDefault extends boolean = false,
    IsOptional extends boolean = false,
> {
    readonly [$builder]: true = true;

    // Internal configuration. Public so schema() and tests can read it, but not
    // meant to be mutated by users directly.
    _type: DefinitionType;
    _default: any = undefined;
    _hasDefault = false;
    _view: number | undefined = undefined;
    _owned = false;
    _unreliable = false;
    _transient = false;
    _deprecated = false;
    _deprecatedThrows = true;
    _static = false;
    _stream = false;
    _optional = false;
    _streamPriority: ((view: any, element: any) => number) | undefined = undefined;

    constructor(type: DefinitionType) {
        this._type = type;
    }

    /** Provide a default value for this field. */
    default(value: T): FieldBuilder<T, true, IsOptional> {
        this._default = value;
        this._hasDefault = true;
        return this as unknown as FieldBuilder<T, true, IsOptional>;
    }

    /** Tag this field with a view tag (DEFAULT_VIEW_TAG when called without arg). */
    view(tag?: number): this {
        // -1 is DEFAULT_VIEW_TAG; kept numeric here to avoid a circular import.
        this._view = tag ?? -1;
        return this;
    }

    /** Mark this field as owned (encoder-side ownership filtering). */
    owned(): this {
        this._owned = true;
        return this;
    }

    /**
     * Mark this field as unreliable — tick patches emit it on the unreliable
     * transport channel. Still persisted to full-sync snapshots unless also
     * tagged with `.transient()`.
     */
    unreliable(): this {
        this._unreliable = true;
        return this;
    }

    /**
     * Mark this field as transient — NOT persisted to full-sync snapshots
     * (`encodeAll` / `encodeAllView`). Late-joining clients see the field
     * only after its next mutation is emitted on a tick patch. Orthogonal
     * to `.unreliable()`.
     */
    transient(): this {
        this._transient = true;
        return this;
    }

    /**
     * Mark this field as static.
     * - Primitive / Schema fields: synchronized once, skips change tracking.
     * - Stream fields (`t.stream(X).static()`): child elements are frozen
     *   after add — post-add field mutations on elements become no-ops.
     */
    static(): this {
        this._static = true;
        return this;
    }

    /**
     * Opt a collection field into priority-batched streaming delivery —
     * ADDs drain at most `maxPerTick` per tick per view (or per broadcast
     * tick without a view). Applies to `t.map(X)` / `t.set(X)` /
     * `t.collection(X)`. Redundant on `t.stream(X)` (the factory already
     * sets this flag).
     *
     * **Not supported on `t.array(X)`.** Array positional operations
     * (`splice`, `unshift`, `reverse`) shift every subsequent index —
     * holding some ADDs back for a later tick while indexes mutate
     * underneath would produce a decoder-side state that doesn't match
     * the server. Use `t.stream(X)` (stable monotonic positions) or
     * `t.map(X).stream()` (keys never shift) instead.
     */
    stream(): this {
        const t = this._type as any;
        if (t && typeof t === "object" && t.array !== undefined) {
            throw new Error(ARRAY_STREAM_NOT_SUPPORTED);
        }
        this._stream = true;
        return this;
    }

    /**
     * Attach a priority callback for per-view `encodeView` delivery. The
     * callback receives the client's StateView and the candidate element;
     * higher return values emit first. Does nothing in broadcast mode
     * (shared `encode()` drains FIFO). Only meaningful on stream fields.
     *
     * ```ts
     * t.stream(Enemy).priority((view, enemy) =>
     *     -dist2(view.anchor, enemy)
     * )
     * ```
     */
    priority<V = any>(fn: (view: any, element: V) => number): this {
        this._streamPriority = fn as (view: any, element: any) => number;
        return this;
    }

    /** Mark this field as deprecated. Pass `false` to silence the access error. */
    deprecated(throws = true): this {
        this._deprecated = true;
        this._deprecatedThrows = throws;
        return this;
    }

    /**
     * Mark this field as optional — inferred instance type becomes
     * `T | undefined` and the property becomes omittable in initialization
     * props. Skips the auto-instantiation of collection / Schema-ref
     * defaults, so the field starts as `undefined` at runtime.
     */
    optional(): FieldBuilder<T | undefined, HasDefault, true> {
        this._optional = true;
        return this as unknown as FieldBuilder<T | undefined, HasDefault, true>;
    }

    toDefinition(): BuilderDefinition {
        return {
            type: this._type,
            default: this._default,
            hasDefault: this._hasDefault,
            view: this._view,
            owned: this._owned,
            unreliable: this._unreliable,
            transient: this._transient,
            deprecated: this._deprecated,
            deprecatedThrows: this._deprecatedThrows,
            static: this._static,
            stream: this._stream,
            optional: this._optional,
            streamPriority: this._streamPriority,
        };
    }
}

export function isBuilder(value: any): value is FieldBuilder<any> {
    return value != null && value[$builder] === true;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function primitive<T>(name: RawPrimitiveType): () => FieldBuilder<T> {
    return () => new FieldBuilder<T>(name);
}

// Accepts a Schema class, a primitive string, or another FieldBuilder as a child type.
export type ChildType =
    | RawPrimitiveType
    | Constructor<Schema>
    | FieldBuilder<any>;

function resolveChild(child: ChildType): DefinitionType {
    if (isBuilder(child)) {
        return child._type;
    }
    return child as DefinitionType;
}

// ---------------------------------------------------------------------------
// t namespace
// ---------------------------------------------------------------------------

// Overloaded factories for collections. Implementation lives in a single function;
// overloads narrow the return type for Schema/primitive/builder children.
// All collection factories tag `HasDefault = true` because schema() auto-
// instantiates an empty collection when no explicit default is given.
interface ArrayFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<ArraySchema<InstanceType<C>>, true, false>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<ArraySchema<InferValueType<P>>, true, false>;
    <V>(child: FieldBuilder<V>): FieldBuilder<ArraySchema<V>, true, false>;
}
interface MapFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<MapSchema<InstanceType<C>>, true, false>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<MapSchema<InferValueType<P>>, true, false>;
    <V>(child: FieldBuilder<V>): FieldBuilder<MapSchema<V>, true, false>;
}
interface SetFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<SetSchema<InstanceType<C>>, true, false>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<SetSchema<InferValueType<P>>, true, false>;
    <V>(child: FieldBuilder<V>): FieldBuilder<SetSchema<V>, true, false>;
}
interface CollectionFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<CollectionSchema<InstanceType<C>>, true, false>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<CollectionSchema<InferValueType<P>>, true, false>;
    <V>(child: FieldBuilder<V>): FieldBuilder<CollectionSchema<V>, true, false>;
}
// t.stream(Entity) — priority-batched collection of Schema instances.
// Element type is restricted to Schema subclasses (no primitives) because
// priority batching relies on stable refIds, which primitives don't carry.
interface StreamFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<StreamSchema<InstanceType<C>>, true, false>;
}

const arrayFactory: ArrayFactory = ((child: ChildType) =>
    new FieldBuilder({ array: resolveChild(child) } as DefinitionType)) as ArrayFactory;
const mapFactory: MapFactory = ((child: ChildType) =>
    new FieldBuilder({ map: resolveChild(child) } as DefinitionType)) as MapFactory;
const setFactory: SetFactory = ((child: ChildType) =>
    new FieldBuilder({ set: resolveChild(child) } as DefinitionType)) as SetFactory;
const collectionFactory: CollectionFactory = ((child: ChildType) =>
    new FieldBuilder({ collection: resolveChild(child) } as DefinitionType)) as CollectionFactory;
const streamFactory: StreamFactory = ((child: ChildType) => {
    const b = new FieldBuilder({ stream: resolveChild(child) } as DefinitionType);
    b._stream = true;
    return b;
}) as StreamFactory;

// Compile-time: does this Schema subclass need arguments at construction?
// A zero-arg or absent `initialize(...)` means schema() will auto-default the
// field to `new X()`, so `HasDefault = true`. A non-zero-arg initialize means
// the user has to provide the ref explicitly.
type RefHasDefault<C> =
    C extends { prototype: { initialize(...args: infer P): any } }
        ? (P extends readonly [] ? true : false)
        : true;

interface RefFactory {
    <C extends Constructor<Schema>>(ctor: C): FieldBuilder<InstanceType<C>, RefHasDefault<C>, false>;
}

const refFactory: RefFactory = (<C extends Constructor<Schema>>(ctor: C) =>
    new FieldBuilder<InstanceType<C>>(ctor as unknown as DefinitionType)) as RefFactory;

export const t = Object.freeze({
    // Primitives
    string: primitive<string>("string"),
    number: primitive<number>("number"),
    boolean: primitive<boolean>("boolean"),
    int8: primitive<number>("int8"),
    uint8: primitive<number>("uint8"),
    int16: primitive<number>("int16"),
    uint16: primitive<number>("uint16"),
    int32: primitive<number>("int32"),
    uint32: primitive<number>("uint32"),
    int64: primitive<number>("int64"),
    uint64: primitive<number>("uint64"),
    float32: primitive<number>("float32"),
    float64: primitive<number>("float64"),
    bigint64: primitive<bigint>("bigint64"),
    biguint64: primitive<bigint>("biguint64"),

    /** Reference to a Schema subtype. `t.array(Item)` usually reads better, but this is available when a plain ref is needed. */
    ref: refFactory,
    array: arrayFactory,
    map: mapFactory,
    set: setFactory,
    collection: collectionFactory,
    stream: streamFactory,
});
