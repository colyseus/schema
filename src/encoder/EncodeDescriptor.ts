/**
 * EncodeDescriptor — per-class snapshot of the values the encode loop needs
 * from a Ref's constructor. Lazily computed once per class (the first time
 * a tree of that class is constructed) and stashed on the constructor via
 * `$encodeDescriptor`. Each ChangeTree caches a reference to its class's
 * descriptor at construction time, so the encode loop reads a single
 * property from the tree instead of chasing 5 separate per-tree lookups:
 *
 *   ctor[$encoder]
 *   ctor[$filter]
 *   ctor[Symbol.metadata]
 *   Metadata.isValidInstance(ref)
 *   getFilterBitmask(metadata)
 *
 * Lives in its own file to break the Encoder.ts ↔ ChangeTree.ts import
 * cycle (ChangeTree caches descriptors at construction; Encoder reads them
 * during encode).
 */
import { Metadata } from "../Metadata.js";
import { $encodeDescriptor, $encoder, $encoders, $filter, $filterBitmask, $numFields, $viewFieldIndexes } from "../types/symbols.js";
import type { StateView } from "./StateView.js";
import type { EncodeOperation } from "./EncodeOperation.js";

export interface EncodeDescriptor {
    encoder: EncodeOperation;
    filter: ((ref: any, index: number, view?: StateView) => boolean) | undefined;
    metadata: any;
    isSchema: boolean;
    /**
     * Bit i set iff field i has a @view tag. 0 for collection trees.
     * Lets `encodeChangeCb` do a single bitwise op instead of a
     * per-field metadata[i]?.tag chase.
     */
    filterBitmask: number;

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
     * encoder fn for primitive-typed fields. Cached here so encode loops
     * skip a `metadata[$encoders]?.[i]` symbol-chain per emission.
     */
    names: string[];
    types: any[];
    tags: (number | undefined)[];
    encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[];
}

function computeFilterBitmask(metadata: any): number {
    if (metadata === undefined) return 0;
    let bm: number | undefined = metadata[$filterBitmask];
    if (bm !== undefined) return bm;
    bm = 0;
    const tagged = metadata[$viewFieldIndexes];
    if (tagged !== undefined) {
        for (let i = 0, len = tagged.length; i < len; i++) bm |= (1 << tagged[i]);
    }
    // Non-enumerable so `for (const k in metadata)` iteration in TypeContext
    // and elsewhere doesn't mistake this cache for a real field index.
    Object.defineProperty(metadata, $filterBitmask, {
        value: bm,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return bm;
}

/**
 * Build the per-field parallel arrays once at descriptor construction.
 * For collection trees (no metadata or no $numFields) this returns empty
 * arrays — readers branch on `isSchema` before touching them anyway.
 */
function buildFieldArrays(metadata: any): {
    names: string[];
    types: any[];
    tags: (number | undefined)[];
    encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[];
} {
    const names: string[] = [];
    const types: any[] = [];
    const tags: (number | undefined)[] = [];
    const encoders: (((bytes: Uint8Array, value: any, it: any) => void) | undefined)[] = [];

    if (metadata === undefined) return { names, types, tags, encoders };

    const numFields = metadata[$numFields];
    if (numFields === undefined) return { names, types, tags, encoders };

    const srcEncoders = metadata[$encoders];
    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        if (field === undefined) {
            // Holes are normal — inheritance can leave gaps. Fill with
            // undefined so indexing is valid.
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
    }
    return { names, types, tags, encoders };
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
    const arrays = buildFieldArrays(metadata);
    const desc: EncodeDescriptor = {
        encoder: ctor[$encoder],
        filter: ctor[$filter],
        metadata,
        isSchema,
        filterBitmask: isSchema ? computeFilterBitmask(metadata) : 0,
        names: arrays.names,
        types: arrays.types,
        tags: arrays.tags,
        encoders: arrays.encoders,
    };
    Object.defineProperty(ctor, $encodeDescriptor, {
        value: desc,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return desc;
}
