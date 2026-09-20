/**
 * EncodeDescriptor — per-class snapshot of the values the encode loop needs
 * from a Ref's constructor. Lazily computed once per class (the first time
 * a tree of that class is constructed) and stashed on the constructor via
 * `$encodeDescriptor`. Each ChangeTree caches a reference to its class's
 * descriptor at construction time, so the encode loop reads a single
 * property from the tree instead of chasing several per-tree lookups.
 *
 * Lives in its own file to break the Encoder.ts ↔ ChangeTree.ts import
 * cycle (ChangeTree caches descriptors at construction; Encoder reads them
 * during encode).
 */
import { Metadata } from "../Metadata.js";
import { DEFAULT_VIEW_TAG } from "../annotations.js";
import { KIND_INDEXED, KIND_SCHEMA } from "../encoding/spec.js";
import { $encodeDescriptor, $encoders, $filter, $fullSyncSkipIndexes, $numFields, $fullStateOnlyFieldIndexes, $recorder, $streamFieldIndexes, $unreliableFieldIndexes, $viewFieldIndexes } from "../types/symbols.js";
import type { StateView } from "./StateView.js";
import type { ArrayLog } from "./ArrayLog.js";
import type { KeyedRecorder } from "./KeyedRecorder.js";

export interface EncodeDescriptor {
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
     * is a `.slice()` of it. Exact size (72 B for two fields, where `[]` grows to
     * a 17-slot store: 192 B) and packed elements — `new Array(n)` is as small but
     * HOLEY, and a holey `$values` made every field read 5…10 % slower in tight
     * loops (`array-iterate/for-of` +9.7 %).
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
    types: any[];
    tags: (number | undefined)[];
    encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[];

    /**
     * Class-level half of same-shape-run eligibility: a Schema whose
     * `[$filter]` is the stock one (only tagged fields consult it) and that
     * has no stream fields. The per-tree half (dirty set, op kinds) is
     * checked per tick by `runEligible`.
     */
    runnable: boolean;
    /** Field indexes a full sync walks: declared and not `@patchOnly` / `@deprecated`. */
    liveIndexes: number[];
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

export function getEncodeDescriptor(ref: any): EncodeDescriptor {
    const ctor = ref.constructor;

    // Use hasOwn — Object.defineProperty on a parent class would otherwise
    // be inherited by every subclass via the prototype chain, and a
    // subclass's instance would read the parent's metadata/encoder. See
    // "should encode the correct class inside an array" for the regression.
    if (Object.prototype.hasOwnProperty.call(ctor, $encodeDescriptor)) {
        return ctor[$encodeDescriptor];
    }

    const metadata = ctor[Symbol.metadata];
    const isSchema = Metadata.isValidInstance(ref);
    const hasAnyView = (metadata?.[$viewFieldIndexes]?.length ?? 0) > 0;

    const collectionKind = ctor.COLLECTION_KIND;
    const kind = (collectionKind === undefined) ? KIND_SCHEMA : (collectionKind <= 2 ? collectionKind : KIND_INDEXED);

    // Per-field parallel arrays (Schemas only; empty for collections).
    const names: string[] = [];
    const types: any[] = [];
    const tags: (number | undefined)[] = [];
    const encoders: EncodeDescriptor["encoders"] = [];
    const liveIndexes: number[] = [];
    let refTypeBitmask = 0;
    let hasRefFieldAbove32 = false;
    let hasTagAbove32 = false;
    let customTagMask = 0;
    const numFields: number = (isSchema && metadata !== undefined) ? (metadata[$numFields] ?? -1) : -1;
    const srcEncoders = metadata?.[$encoders];
    const skip: number[] | undefined = metadata?.[$fullSyncSkipIndexes];

    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        if (field === undefined) {
            // Holes are normal — inheritance can leave gaps.
            names[i] = undefined!;
            types[i] = undefined;
            tags[i] = undefined;
            encoders[i] = undefined;
            continue;
        }
        names[i] = field.name;
        types[i] = field.type;
        tags[i] = field.tag;
        encoders[i] = srcEncoders?.[i];
        if (skip === undefined || !skip.includes(i)) liveIndexes.push(i);

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
        fullStateOnlyBitmask: indexesToBitmask(metadata?.[$fullStateOnlyFieldIndexes]),
        unreliableBitmask: indexesToBitmask(metadata?.[$unreliableFieldIndexes]),
        streamBitmask: indexesToBitmask(metadata?.[$streamFieldIndexes]),
        names,
        types,
        tags,
        encoders,
        liveIndexes,
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
