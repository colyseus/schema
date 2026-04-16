import type { ArraySchema } from "./custom/ArraySchema.js";
import type { MapSchema } from "./custom/MapSchema.js";
import type { SetSchema } from "./custom/SetSchema.js";
import type { CollectionSchema } from "./custom/CollectionSchema.js";
import type { Schema } from "../Schema.js";
import type { DefinitionType, RawPrimitiveType } from "../annotations.js";
import type { InferValueType, Constructor } from "./HelperTypes.js";
import { $builder } from "./symbols.js";

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
}

/**
 * Type-function that infers the instance value for a builder.
 */
export type BuilderOf<T> = FieldBuilder<T>;

/**
 * Chainable field builder. Instances are produced by `t.*()` factories.
 *
 * The generic parameter T is the runtime/JS type of the field (e.g. `number`,
 * `string`, `ArraySchema<Item>`). schema() reads the internal configuration
 * via `toDefinition()` and wires up metadata through the existing pipeline.
 */
export class FieldBuilder<T = unknown> {
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

    constructor(type: DefinitionType) {
        this._type = type;
    }

    /** Provide a default value for this field. */
    default(value: T): this {
        this._default = value;
        this._hasDefault = true;
        return this;
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

    /** Mark this field as static — synchronized once, skips change tracking (flag-only for now). */
    static(): this {
        this._static = true;
        return this;
    }

    /** Mark this field as streamed — all intermediate values synchronized (flag-only for now). */
    stream(): this {
        this._stream = true;
        return this;
    }

    /** Mark this field as deprecated. Pass `false` to silence the access error. */
    deprecated(throws = true): this {
        this._deprecated = true;
        this._deprecatedThrows = throws;
        return this;
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
interface ArrayFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<ArraySchema<InstanceType<C>>>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<ArraySchema<InferValueType<P>>>;
    <V>(child: FieldBuilder<V>): FieldBuilder<ArraySchema<V>>;
}
interface MapFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<MapSchema<InstanceType<C>>>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<MapSchema<InferValueType<P>>>;
    <V>(child: FieldBuilder<V>): FieldBuilder<MapSchema<V>>;
}
interface SetFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<SetSchema<InstanceType<C>>>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<SetSchema<InferValueType<P>>>;
    <V>(child: FieldBuilder<V>): FieldBuilder<SetSchema<V>>;
}
interface CollectionFactory {
    <C extends Constructor<Schema>>(child: C): FieldBuilder<CollectionSchema<InstanceType<C>>>;
    <P extends RawPrimitiveType>(child: P): FieldBuilder<CollectionSchema<InferValueType<P>>>;
    <V>(child: FieldBuilder<V>): FieldBuilder<CollectionSchema<V>>;
}

const arrayFactory: ArrayFactory = ((child: ChildType) =>
    new FieldBuilder({ array: resolveChild(child) } as DefinitionType)) as ArrayFactory;
const mapFactory: MapFactory = ((child: ChildType) =>
    new FieldBuilder({ map: resolveChild(child) } as DefinitionType)) as MapFactory;
const setFactory: SetFactory = ((child: ChildType) =>
    new FieldBuilder({ set: resolveChild(child) } as DefinitionType)) as SetFactory;
const collectionFactory: CollectionFactory = ((child: ChildType) =>
    new FieldBuilder({ collection: resolveChild(child) } as DefinitionType)) as CollectionFactory;

function refFactory<C extends Constructor<Schema>>(ctor: C): FieldBuilder<InstanceType<C>> {
    return new FieldBuilder<InstanceType<C>>(ctor as unknown as DefinitionType);
}

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
});
