/**
 * EncodeDescriptor — per-class snapshot of a Ref constructor's fields: what
 * the encode loop needs, the field setters construction / `assign()` use, and
 * the decoder's readers and access policy. Lazily computed once per class
 * (the first time an instance of that class is constructed or decoded) and
 * stashed on the constructor via `$encodeDescriptor`. Each ChangeTree caches a reference to its class's
 * descriptor at construction time, so the encode loop reads a single
 * property from the tree instead of chasing several per-tree lookups.
 *
 * Lives in its own file to break the Encoder.ts ↔ ChangeTree.ts import
 * cycle (ChangeTree caches descriptors at construction; Encoder reads them
 * during encode).
 */
import { DEFAULT_VIEW_TAG } from "../annotations.js";
import { KIND_INDEXED, KIND_MAP, KIND_SCHEMA } from "../encoding/spec.js";
import { $descriptors, $encodeDescriptor, $encoders, $filter, $filterByChild, $fullSyncSkipIndexes, $numFields, $fullStateOnlyFieldIndexes, $recorder, $streamFieldIndexes, $unreliableFieldIndexes, $viewFieldIndexes } from "../types/symbols.js";
import type { StateView } from "./StateView.js";
import type { ArrayLog } from "./ArrayLog.js";
import type { KeyedRecorder } from "./KeyedRecorder.js";
import { resolvesTo, setterOf } from "../types/utils.js";
import { Metadata } from "../Metadata.js";
import { readerOf } from "../types/quantize.js";
import type { RefInfo } from "../decoder/DecodeOperation.js";

/** How the decoder reaches a field — see `EncodeDescriptor.access`. */
export const ACCESS_NAMED = 0, ACCESS_DIRECT = 1, ACCESS_VALUES = 2, ACCESS_DEPRECATED = 3;

export interface EncodeDescriptor {
    /** The class this describes (`descriptorOf`'s own-descriptor check). */
    ctor: Function;
    filter: ((ref: any, index: number, view?: StateView) => boolean) | undefined;
    metadata: any;
    isSchema: boolean;
    /** KIND_SCHEMA / KIND_MAP / KIND_ARRAY / KIND_INDEXED — per class, so frames don't probe the instance. */
    kind: number;
    /** Recorder factory for collection classes (`static [$recorder]`); undefined for Schemas. */
    newRecorder: (() => ArrayLog | KeyedRecorder) | undefined;
    /** Highest field index (`metadata[$numFields]`), -1 for collections. */
    numFields: number;
    /**
     * A PACKED array of `numFields + 1` `undefined`s; every instance's `$values`
     * is a `.slice()` of it: exact size (`[]` would grow a larger store) and
     * packed elements (`new Array(n)` is as small but HOLEY, which slows every
     * field read in tight loops).
     */
    valuesTemplate: any[];
    /**
     * Bit i set iff field i has a @view tag. 0 for collection trees.
     * Fields 0–31 only, like the bitmasks below — readers consult `tags`
     * past that.
     */
    filterBitmask: number;

    /**
     * Class-level "any field has the flag" booleans + per-field bitmasks.
     * Hot path: per-mutation `_routeAndRecord` calls `isFieldFullStateOnly` and
     * `isFieldUnreliable`. The common case is "no static/unreliable fields
     * anywhere on this class" (booleans short-circuit before the symbol-keyed
     * metadata lookup); the secondary common case is "this class has some
     * such fields and we need to know if THIS field is one" — the bitmask
     * answers in one bitwise op instead of an `Array.includes` linear scan.
     *
     * Bitmasks cover fields 0–31 only — shift counts wrap at 32. Fields ≥32
     * fall back to `Metadata.hasXAtIndex`.
     */
    hasAnyFullStateOnly: boolean;
    hasAnyUnreliable: boolean;
    hasAnyStream: boolean;
    /**
     * Class-level "any field carries a `@view` tag". Read by
     * `ChangeTree.hasFilteredFields` to decide whether a parent tree must
     * be included in a view's bootstrap.
     */
    hasAnyView: boolean;
    fullStateOnlyBitmask: number;
    unreliableBitmask: number;
    /**
     * Bit i set iff field i holds a `t.stream(...)` collection. Hot encode
     * path reads this to dispatch stream fields into the priority/budget
     * gate instead of the normal recorder iteration.
     */
    streamBitmask: number;

    /**
     * Per-field parallel arrays — Schemas only (empty arrays for
     * collections). Replaces hot-path `metadata[i].name` / `metadata[i].type`
     * / `metadata[i].tag` chains with direct array indexing on a small
     * fixed-shape object.
     *
     * Sparse where natural: `tags[i]` is undefined unless field i carries
     * a @view tag; readers should null-check before comparing.
     *
     * `encoders[i]` mirrors `metadata[$encoders]` — the pre-computed
     * encoder fn for primitive-typed fields.
     */
    names: string[];
    /**
     * Per field: what a `ref[name] = value` store runs — the prototype
     * setter, or a plain store for a data field (`manual: true`, a reflected
     * decoder class). Construction, `assign()` and `clone()` call it
     * directly: a store under a changing key takes V8's generic path (~3×).
     */
    setters: ((this: any, value: any) => void)[];
    types: any[];
    tags: (number | undefined)[];
    encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[];
    /**
     * Decoder: a pre-resolved reader per primitive / quantized field
     * (`undefined` for refs), so the per-slot path is one array load instead
     * of a string-keyed dispatch. Taken from the live `decode` table when the
     * descriptor is built, so custom primitive types registered after import
     * (before the class is first used) are honoured.
     */
    readers: (((bytes: Uint8Array, it: any) => any) | undefined)[];
    /**
     * Decoder: per field, whether it may bypass the accessor. Behind the one
     * the library installed (`metadata[$descriptors]`) the value lives in
     * `values[index]` and the setter adds only validation and change
     * tracking, which decoding has no use for: a primitive takes
     * `decodeDirectSlot` (`ACCESS_DIRECT`), a ref is read and written in
     * `values` by `decodeSlot` (`ACCESS_VALUES`). `ACCESS_NAMED` otherwise —
     * `ref[name]` for `{ manual: true }` fields, and to call a user's accessor
     * override; `ACCESS_DEPRECATED` fields are read off the wire and dropped.
     */
    access: number[];
    /** Decoder: the class's shared decode record (`DecodeOperation.schemaRefInfo`), built on first use. */
    refInfo: RefInfo | undefined;

    /**
     * Class-level half of same-shape-run eligibility: a Schema whose
     * `[$filter]` is the stock one (only tagged fields consult it) and that
     * has no stream fields. The per-tree half (dirty set, op kinds) is
     * checked per tick by `runEligible`.
     */
    runnable: boolean;
    /**
     * Class-level half of keyed-op routing: a Map / Set / Collection whose
     * `[$filter]` is child visibility (`$filterByChild`). The per-tree half
     * (Schema children, not a stream, children not sharing visibility) is
     * checked per tick in `Encoder._prepareTick`.
     */
    routable: boolean;
    /** Field indexes a full sync walks: declared and not `@patchOnly` / `@deprecated`. */
    liveIndexes: number[];
    /** Every live field resolves to the accessor the library installed, so an empty `$values` slot means unset (no `ref[name]` read needed). */
    liveInValues: boolean;
    /** Bit i set iff field i (< 32) is ref-typed. */
    refTypeBitmask: number;
    hasRefFieldAbove32: boolean;
    /** Any `@view` tag on a field index ≥ 32 (past `filterBitmask`). */
    hasTagAbove32: boolean;
    /** Mask of the custom `@view(tag)` bits declared on this class. */
    customTagMask: number;
}

/**
 * Bitmask of field indexes 0–31 in `indexes`. For fields ≥32 callers must
 * fall back to the array lookup — shift counts wrap at 32, so an unguarded
 * `1 << 40` would set bit 8 and misclassify field 8.
 */
function indexesToBitmask(indexes: number[] | undefined): number {
    if (indexes === undefined) return 0;
    let bm = 0;
    for (let i = 0, len = indexes.length; i < len; i++) {
        const idx = indexes[i];
        if (idx < 32) bm |= (1 << idx);
    }
    return bm;
}

/** `ref`'s class descriptor (public alias of {@link descriptorOf}, for the `/input` bundle). */
export function getEncodeDescriptor(ref: any): EncodeDescriptor {
    return descriptorOf(ref.constructor);
}

/**
 * The class's descriptor, built on first use. Own descriptor only: a subclass
 * must not read its parent's, inherited through the constructor's prototype
 * chain (see "should encode the correct class inside an array"). Checked by
 * identity rather than `hasOwnProperty` (a builtin call), and tiny so it
 * inlines into construction and `createRef`.
 */
export function descriptorOf(ctor: any): EncodeDescriptor {
    const cached: EncodeDescriptor | undefined = ctor[$encodeDescriptor];
    return (cached !== undefined && cached.ctor === ctor) ? cached : buildDescriptor(ctor);
}

function buildDescriptor(ctor: any): EncodeDescriptor {
    const metadata = ctor[Symbol.metadata];
    const isSchema = !!Metadata.isValidInstance(ctor.prototype);
    const hasAnyView = (metadata?.[$viewFieldIndexes]?.length ?? 0) > 0;

    const collectionKind = ctor.COLLECTION_KIND;
    const kind = (collectionKind === undefined) ? KIND_SCHEMA : (collectionKind <= 2 ? collectionKind : KIND_INDEXED);

    // Per-field parallel arrays (Schemas only; empty for collections).
    const names: string[] = [];
    const setters: EncodeDescriptor["setters"] = [];
    const types: any[] = [];
    const tags: (number | undefined)[] = [];
    const encoders: EncodeDescriptor["encoders"] = [];
    const readers: EncodeDescriptor["readers"] = [];
    const access: number[] = [];
    const liveIndexes: number[] = [];
    let liveInValues = true;
    const descriptors = metadata?.[$descriptors];
    let refTypeBitmask = 0;
    let hasRefFieldAbove32 = false;
    let hasTagAbove32 = false;
    let customTagMask = 0;
    const numFields: number = isSchema ? metadata[$numFields] : -1;
    const srcEncoders = metadata?.[$encoders];
    const skip: number[] | undefined = metadata?.[$fullSyncSkipIndexes];

    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        if (field === undefined) {
            // Holes are normal — inheritance can leave gaps.
            names[i] = undefined!;
            setters[i] = undefined!;
            types[i] = undefined;
            tags[i] = undefined;
            encoders[i] = undefined;
            readers[i] = undefined;
            access[i] = ACCESS_NAMED;
            continue;
        }
        names[i] = field.name;
        setters[i] = setterOf(ctor.prototype, field.name);
        types[i] = field.type;
        tags[i] = field.tag;
        encoders[i] = srcEncoders?.[i];
        readers[i] = readerOf(field.type);
        const inValues = resolvesTo(ctor.prototype, field.name, descriptors?.[field.name]);
        access[i] = (field.deprecated === true) ? ACCESS_DEPRECATED
            : !inValues ? ACCESS_NAMED
            : (readers[i] !== undefined) ? ACCESS_DIRECT : ACCESS_VALUES;
        if (skip === undefined || !skip.includes(i)) {
            liveIndexes.push(i);
            if (!inValues) liveInValues = false;
        }

        const isRef = typeof field.type !== "string" && field.type.quantized === undefined;
        if (isRef) {
            if (i < 32) refTypeBitmask |= (1 << i);
            else hasRefFieldAbove32 = true;
        }
        const tag = field.tag;
        if (tag !== undefined && i >= 32) hasTagAbove32 = true;
        if (tag !== undefined && tag !== DEFAULT_VIEW_TAG) {
            customTagMask |= tag;
        }
    }

    // For Schema classes with no `@view`-tagged fields the per-field
    // `filter(ref, index, view)` call is a provable no-op — leave it
    // undefined so the emitter's `filter !== undefined && …` short-circuit
    // skips the call. Keyed collections keep their instance-level filter;
    // arrays have none (the emitter checks element visibility directly).
    const filter = (isSchema && !hasAnyView) ? undefined : ctor[$filter];
    // stock filter = the one owned by the root Schema class (its [[Prototype]] is Function.prototype)
    let filterOwner: any = ctor;
    while (filterOwner && !Object.prototype.hasOwnProperty.call(filterOwner, $filter)) filterOwner = Object.getPrototypeOf(filterOwner);
    const stockFilter = filterOwner === null || filterOwner === undefined || Object.getPrototypeOf(filterOwner) === Function.prototype;
    const hasAnyStream = (metadata?.[$streamFieldIndexes]?.length ?? 0) > 0;
    const desc: EncodeDescriptor = {
        ctor,
        filter,
        metadata,
        isSchema,
        kind,
        newRecorder: ctor[$recorder],
        numFields,
        valuesTemplate: Array.from({ length: numFields + 1 }, (): any => undefined),
        filterBitmask: isSchema ? indexesToBitmask(metadata?.[$viewFieldIndexes]) : 0,
        hasAnyFullStateOnly: (metadata?.[$fullStateOnlyFieldIndexes]?.length ?? 0) > 0,
        hasAnyUnreliable: (metadata?.[$unreliableFieldIndexes]?.length ?? 0) > 0,
        hasAnyStream,
        hasAnyView,
        runnable: isSchema && stockFilter && !hasAnyStream,
        routable: (kind === KIND_MAP || kind === KIND_INDEXED) && (filter as any)?.[$filterByChild] === true,
        fullStateOnlyBitmask: indexesToBitmask(metadata?.[$fullStateOnlyFieldIndexes]),
        unreliableBitmask: indexesToBitmask(metadata?.[$unreliableFieldIndexes]),
        streamBitmask: indexesToBitmask(metadata?.[$streamFieldIndexes]),
        names,
        setters,
        types,
        tags,
        encoders,
        readers,
        access,
        refInfo: undefined,
        liveIndexes,
        liveInValues,
        refTypeBitmask,
        hasRefFieldAbove32,
        hasTagAbove32,
        customTagMask,
    };
    Object.defineProperty(ctor, $encodeDescriptor, {
        value: desc,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return desc;
}
