import { DEFAULT_VIEW_TAG } from "../annotations.js";
import type { EncodeDescriptor } from "../encoder/EncodeDescriptor.js";
import { $fullSyncSkipIndexes, $numFields } from "../types/symbols.js";
import { encode } from "../encoding/encode.js";
import { decodeQuantized, isQuantizedType } from "../types/quantize.js";
import { decode6, encode6 } from "./encoding.js";
import { KIND_INDEXED, KIND_SCHEMA } from "./spec.js";

/**
 * Per-class values the v6 encoder needs beyond `EncodeDescriptor`. Built once
 * per class on first use and cached on `desc.v6`.
 */
export interface V6ClassInfo {
    /** KIND_SCHEMA / KIND_MAP / KIND_ARRAY / KIND_INDEXED — per class, so frames don't probe the instance. */
    kind: number;
    /** Highest field index (`metadata[$numFields]`), -1 for collections. */
    numFields: number;
    names: string[];
    types: any[];
    /** Pre-baked primitive writers; `string` and `number` use the v6 forms. */
    encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[];
    /** Field indexes a full sync walks: declared and not `@patchOnly` / `@deprecated`. */
    liveIndexes: number[];
    /** Bit i set iff field i (< 32) is ref-typed. */
    refTypeBitmask: number;
    hasRefFieldAbove32: boolean;
    /** Any `@view` tag on a field index ≥ 32 (past `filterBitmask`). */
    hasTagAbove32: boolean;
    /** Distinct custom `@view(tag)` bits declared on this class. */
    customTagBits: number[];
    tags: (number | undefined)[];
    filterBitmask: number;
}

/** `ctor` is the instance's constructor: the kind is read from its `COLLECTION_KIND` static. */
export function getV6ClassInfo(desc: EncodeDescriptor, ctor: any): V6ClassInfo {
    return (desc.v6 as V6ClassInfo | undefined) ?? (desc.v6 = build(desc, ctor));
}

function build(desc: EncodeDescriptor, ctor: any): V6ClassInfo {
    const metadata = desc.metadata;
    const numFields: number = (desc.isSchema && metadata !== undefined) ? (metadata[$numFields] ?? -1) : -1;
    const types = desc.types;
    const encoders: V6ClassInfo["encoders"] = [];
    const liveIndexes: number[] = [];
    const skip: number[] | undefined = metadata?.[$fullSyncSkipIndexes];
    let refTypeBitmask = 0;
    let hasRefFieldAbove32 = false;
    let hasTagAbove32 = false;
    const tagBits = new Set<number>();

    for (let i = 0; i <= numFields; i++) {
        const type = types[i];
        if (type === undefined) { encoders[i] = undefined; continue; }
        if (skip === undefined || !skip.includes(i)) liveIndexes.push(i);

        const isRef = typeof type !== "string" && type.quantized === undefined;
        if (isRef) {
            if (i < 32) refTypeBitmask |= (1 << i);
            else hasRefFieldAbove32 = true;
        }
        const enc = desc.encoders[i];
        encoders[i] = (enc === encode.string) ? encode6.string : (enc === encode.number) ? encode6.number : enc;

        const tag = desc.tags[i];
        if (tag !== undefined && i >= 32) hasTagAbove32 = true;
        if (tag !== undefined && tag !== DEFAULT_VIEW_TAG) {
            for (let bits = tag; bits > 0; bits &= bits - 1) tagBits.add(bits & -bits);
        }
    }

    const collectionKind = ctor?.COLLECTION_KIND;
    return {
        kind: collectionKind === undefined ? KIND_SCHEMA : (collectionKind <= 2 ? collectionKind : KIND_INDEXED),
        numFields,
        names: desc.names,
        types,
        encoders,
        liveIndexes,
        refTypeBitmask,
        hasRefFieldAbove32,
        hasTagAbove32,
        customTagBits: Array.from(tagBits),
        tags: desc.tags,
        filterBitmask: desc.filterBitmask,
    };
}

/**
 * Per-class values the v6 decoder needs: the field table by wire index and a
 * pre-resolved reader per primitive / quantized field (`undefined` for refs),
 * so the per-slot path is one array load instead of a string-keyed dispatch.
 * Cached on the constructor.
 */
export interface V6DecodeInfo {
    fields: any[];
    readers: (((bytes: Uint8Array, it: any) => any) | undefined)[];
}

const $decodeInfo = Symbol.for("$v6decodeInfo");

export function getV6DecodeInfo(ctor: any): V6DecodeInfo {
    let info: V6DecodeInfo | undefined = ctor[$decodeInfo];
    if (info !== undefined && Object.prototype.hasOwnProperty.call(ctor, $decodeInfo)) return info;
    const metadata = ctor[Symbol.metadata];
    const numFields: number = metadata?.[$numFields] ?? -1;
    const fields: any[] = [];
    const readers: V6DecodeInfo["readers"] = [];
    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        fields[i] = field;
        if (field === undefined) { readers[i] = undefined; continue; }
        const type = field.type;
        readers[i] = (typeof type === "string") ? decode6[type]
            : isQuantizedType(type) ? (bytes: Uint8Array, it: any) => decodeQuantized(type.quantized, bytes, it)
            : undefined;
    }
    info = { fields, readers };
    // own property: a subclass must not inherit its parent's (shorter) table
    Object.defineProperty(ctor, $decodeInfo, { value: info, enumerable: false, writable: true, configurable: true });
    return info;
}
