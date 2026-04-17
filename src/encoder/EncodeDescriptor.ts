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
import { $encodeDescriptor, $encoder, $filter, $filterBitmask, $viewFieldIndexes } from "../types/symbols.js";
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
    const desc: EncodeDescriptor = {
        encoder: ctor[$encoder],
        filter: ctor[$filter],
        metadata,
        isSchema,
        filterBitmask: isSchema ? computeFilterBitmask(metadata) : 0,
    };
    Object.defineProperty(ctor, $encodeDescriptor, {
        value: desc,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return desc;
}
