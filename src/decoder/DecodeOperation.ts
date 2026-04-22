import { OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { Schema } from "../Schema.js";
import type { IRef, Ref } from "../encoder/ChangeTree.js";
import type { Decoder } from "./Decoder.js";
import { Iterator, decode } from "../encoding/decode.js";
import { $childType, $deleteByIndex, $getByIndex, $proxyTarget, $refId } from "../types/symbols.js";

import type { ArraySchema } from "../types/custom/ArraySchema.js";

import { getType } from "../types/registry.js";
import { Collection } from "../types/HelperTypes.js";

export interface DataChange<T = any, F = string> {
    ref: IRef,
    refId: number,
    op: OPERATION,
    /** Set for Schema field changes; omitted for collection item changes (which carry a `dynamicIndex` instead). */
    field?: F;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

export const DEFINITION_MISMATCH = -1;

/**
 * When no `triggerChanges` subscriber is attached, `Decoder.decode` passes
 * `null` so the per-field change objects are never allocated. Every push
 * site uses `allChanges?.push(...)` — optional chaining also short-circuits
 * the object literal, so there's nothing to collect and nothing to throw
 * away.
 */
export type DecodeOperation<T extends Schema = any> = (
    decoder: Decoder<T>,
    bytes: Uint8Array,
    it: Iterator,
    ref: IRef,
    allChanges: DataChange[] | null,
) => number | void;

/**
 * Collection-kind discriminator declared on each collection class as
 * `static COLLECTION_KIND = CollectionKind.X`. The decoder's key/value
 * dispatch used to make three back-to-back `typeof(ref.method) ===
 * "function"` checks per entry; those collapse into one switch on the
 * target's class tag. Missing / `undefined` on a ref hits the switch's
 * `default` branch and logs a warning — a guard for future collection
 * types that land without a tag.
 *
 * Declared as a `const` object (not a TS `enum`) so the codegen parser —
 * which picks up every `EnumDeclaration` in the lib source via transitive
 * imports — doesn't emit a generated .cs file for it.
 */
export const CollectionKind = {
    Map: 1,
    Array: 2,
    Set: 3,
    Collection: 4,
    Stream: 5,
} as const;
export type CollectionKind = typeof CollectionKind[keyof typeof CollectionKind];

/**
 * Structural type for any class that participates in the `decodeKeyValue-
 * Operation` dispatch. Lets the hot-path read `tgt.constructor.COLLECTION_KIND`
 * without an `any` cast.
 */
export interface CollectionCtor {
    readonly COLLECTION_KIND: CollectionKind;
}

/**
 * Decode the next wire value for `ref[index]`. Returns the decoded value.
 *
 * Callers pass `previousValue` explicitly — it's the current value at the
 * slot before decoding and is needed for ref-count bookkeeping (on DELETE)
 * and for the DELETE_AND_ADD self-reassign case. Keeping it as a parameter
 * lets this function return a single primitive instead of a pair, so the
 * hot call path allocates nothing.
 */
export function decodeValue<T extends Ref>(
    decoder: Decoder,
    operation: OPERATION,
    ref: T,
    index: number,
    previousValue: any,
    type: any,
    bytes: Uint8Array,
    it: Iterator,
    allChanges: DataChange[] | null,
): any {
    const $root = decoder.root;

    let value: any;

    if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
    {
        // Flag `refId` for garbage collection.
        const previousRefId = previousValue?.[$refId];
        if (previousRefId !== undefined) { $root.removeRef(previousRefId); }

        //
        // Delete operations
        //
        if (operation !== OPERATION.DELETE_AND_ADD) {
            ref[$deleteByIndex](index);
        }

        value = undefined;
    }

    if (operation === OPERATION.DELETE) {
        //
        // Don't do anything
        //

    } else if (typeof (type) === "string") {
        //
        // Primitive value (number, string, boolean, …). Hot-path first
        // because steady-state ticks are dominated by primitive field
        // updates — moves us past a cheap typeof check instead of a
        // Symbol-metadata lookup via `Schema.is`.
        //
        value = (decode as any)[type](bytes, it);

    } else if (Schema.is(type)) {
        const refId = decode.number(bytes, it);
        value = $root.refs.get(refId);

        if ((operation & OPERATION.ADD) === OPERATION.ADD) {
            const childType = decoder.getInstanceType(bytes, it, type);
            if (!value) {
                value = decoder.createInstanceOfType(childType);
            }

            $root.addRef(
                refId,
                value,
                (
                    value !== previousValue || // increment ref count if value has changed
                    (operation === OPERATION.DELETE_AND_ADD && value === previousValue) // increment ref count if the same instance is being added again
                )
            );
        }

    } else {
        const typeDef = getType(Object.keys(type)[0]);
        const refId = decode.number(bytes, it);

        // `initializeForDecoder` is a static on every registered collection
        // class — it does `Object.create(Class.prototype)` + the class-
        // field init + assigns an untracked `$changes` directly. Keeps
        // the decoder free of collection-type internals.
        const valueRef: Ref = ($root.refs.has(refId))
            ? previousValue || $root.refs.get(refId)
            : (typeDef.constructor as any).initializeForDecoder();

        value = valueRef.clone(true);
        value[$childType] = Object.values(type)[0]; // cache childType for ArraySchema and MapSchema

        if (previousValue) {
            let previousRefId = previousValue[$refId];

            if (previousRefId !== undefined && refId !== previousRefId) {
                //
                // enqueue onRemove if structure has been replaced.
                //
                const entries: IterableIterator<[any, any]> = (previousValue as any).entries();
                let iter: IteratorResult<[any, any]>;
                while ((iter = entries.next()) && !iter.done) {
                    const [key, value] = iter.value;

                    // if value is a schema, remove its reference
                    if (typeof(value) === "object") {
                        previousRefId = value[$refId];
                        $root.removeRef(previousRefId);
                    }

                    allChanges?.push({
                        ref: previousValue,
                        refId: previousRefId,
                        op: OPERATION.DELETE,
                        field: key,
                        value: undefined,
                        previousValue: value,
                    });
                }

            }
        }

        $root.addRef(refId, value, (
            valueRef !== previousValue ||
            (operation === OPERATION.DELETE_AND_ADD && valueRef === previousValue)
        ));
    }

    return value;
}

export const decodeSchemaOperation: DecodeOperation = function <T extends Schema>(
    decoder: Decoder<any>,
    bytes: Uint8Array,
    it: Iterator,
    ref: T,
    allChanges: DataChange[] | null,
) {
    const first_byte = bytes[it.offset++];
    const metadata: Metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

    // "compressed" index + operation
    const operation = (first_byte >> 6) << 6
    const index = first_byte % (operation || 255);

    // skip early if field is not defined
    const field = metadata[index];
    if (field === undefined) {
        console.warn("@colyseus/schema: field not defined at", { index, ref: ref.constructor.name, metadata });
        return DEFINITION_MISMATCH;
    }

    const previousValue = ref[$getByIndex](index);
    const value = decodeValue(
        decoder,
        operation,
        ref,
        index,
        previousValue,
        field.type,
        bytes,
        it,
        allChanges,
    );

    if (value !== null && value !== undefined) {
        // Write via the generated setter. Bypass to `(ref as any)[$values][index]`
        // was attempted but only works for @type-decorated classes (which
        // install accessor descriptors reading from `$values`). Reflection-
        // decoded classes install a plain data-property descriptor instead,
        // so their value lives as an own property on the instance — direct
        // `$values[index]` writes are invisible to the getter on that path.
        // Two-mode dispatch would cost more than the ~3% it'd save.
        ref[field.name as keyof T] = value;
    }

    // add change
    if (previousValue !== value) {
        allChanges?.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            field: field.name,
            value,
            previousValue,
        });
    }
}

export const decodeKeyValueOperation: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: Uint8Array,
    it: Iterator,
    ref: Ref,
    allChanges: DataChange[] | null,
) {
    // Unwrap ArraySchema Proxy once so subsequent property reads skip the
    // `get` trap. `$proxyTarget` is a self-reference on the target; on
    // non-proxied collections (Map/Set/Collection/Stream) the lookup is
    // undefined and we fall back to `ref`.
    const tgt: any = (ref as any)[$proxyTarget] ?? ref;

    // "uncompressed" index + operation (array/map items)
    const operation = bytes[it.offset++];

    if (operation === OPERATION.CLEAR) {
        //
        // When decoding:
        // - enqueue items for DELETE callback.
        // - flag child items for garbage collection.
        //
        decoder.removeChildRefs(tgt as Collection, allChanges);

        tgt.clear();
        return;
    }

    const index = decode.number(bytes, it);
    const type = tgt[$childType];
    // One constructor lookup, one integer read → switch. Replaces three
    // `typeof(ref.method) === "function"` dispatches per entry.
    const kind: CollectionKind = (tgt.constructor as CollectionCtor).COLLECTION_KIND;

    let dynamicIndex: number | string;

    if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
        if (kind === CollectionKind.Map) {
            dynamicIndex = decode.string(bytes, it); // MapSchema uses a wire-delivered string key
            tgt.setIndex(index, dynamicIndex);
        } else {
            dynamicIndex = index;
        }
    } else {
        dynamicIndex = tgt.getIndex(index);
    }

    const previousValue = tgt[$getByIndex](index);
    const value = decodeValue(
        decoder,
        operation,
        ref,
        index,
        previousValue,
        type,
        bytes,
        it,
        allChanges,
    );

    if (value !== null && value !== undefined) {
        switch (kind) {
            case CollectionKind.Map:
                tgt.$items.set(dynamicIndex as string, value);
                break;

            case CollectionKind.Array:
                tgt.$setAt(index, value, operation);
                break;

            // SetSchema / CollectionSchema / StreamSchema — use the wire-
            // index we decoded above so server/client `$items` stay in sync
            // regardless of duplicate emission (e.g. a bootstrap that walks
            // both `encodeAll` and the shared recorder emits the same ADD
            // op twice). Previous implementation called `ref.add(value)`
            // and let the decoder-side `$refId++` allocate a new index per
            // call — which for CollectionSchema (no value-dedup) turned
            // duplicate wire ADDs into duplicate client-side entries.
            case CollectionKind.Set:
            case CollectionKind.Collection:
            case CollectionKind.Stream:
                if (!tgt.$items.has(index)) {
                    tgt.$items.set(index, value);
                    // Keep the decoder's monotonic counter ahead of any
                    // wire-index we've seen so future server-side `.add()`
                    // allocations don't collide with ones already decoded.
                    // (StreamSchema has no `$refId` counter — `typeof`
                    // guards the Set/Collection path.)
                    if (typeof tgt.$refId === "number" && index >= tgt.$refId) {
                        tgt.$refId = index + 1;
                    }
                }
                break;

            default:
                // A future collection type landed without a COLLECTION_KIND
                // tag. Surface it loudly instead of silently dropping the
                // value — the missing entry here is the only place the new
                // type's item-storage semantics need to be wired up.
                console.warn(
                    `@colyseus/schema: missing COLLECTION_KIND on ${tgt.constructor?.name} — item at index ${index} was not stored.`
                );
                break;
        }
    }

    // add change
    if (previousValue !== value) {
        allChanges?.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            dynamicIndex,
            value,
            previousValue,
        });
    }
}

export const decodeArray: DecodeOperation = function (
    decoder: Decoder<any>,
    bytes: Uint8Array,
    it: Iterator,
    ref: ArraySchema,
    allChanges: DataChange[] | null,
) {
    // Unwrap the Proxy once — ref is always an ArraySchema here.
    const tgt: any = (ref as any)[$proxyTarget] ?? ref;

    // "uncompressed" index + operation (array/map items)
    let operation = bytes[it.offset++];
    let index: number;

    if (operation === OPERATION.CLEAR) {
        //
        // When decoding:
        // - enqueue items for DELETE callback.
        // - flag child items for garbage collection.
        //
        decoder.removeChildRefs(tgt as Collection, allChanges);
        tgt.clear();
        return;

    } else if (operation === OPERATION.REVERSE) {
        tgt.reverse();
        return;

    } else if (operation === OPERATION.DELETE_BY_REFID) {
        // TODO: refactor here, try to follow same flow as below
        const refId = decode.number(bytes, it);
        const previousValue = decoder.root.refs.get(refId);
        index = tgt.findIndex((value: any) => value === previousValue);
        tgt[$deleteByIndex](index);
        allChanges?.push({
            ref,
            refId: decoder.currentRefId,
            op: OPERATION.DELETE,
            dynamicIndex: index,
            value: undefined,
            previousValue,
        });

        return;

    } else if (operation === OPERATION.ADD_BY_REFID) {
        const refId = decode.number(bytes, it);
        const itemByRefId = decoder.root.refs.get(refId);

        // if item already exists, use existing index
        if (itemByRefId) {
            index = tgt.findIndex((value: any) => value === itemByRefId);
        }

        // fallback to use last index
        if (index === -1 || index === undefined) {
            index = tgt.length;
        }

    } else {
        index = decode.number(bytes, it);
    }

    const type = tgt[$childType];

    let dynamicIndex: number | string = index;

    const previousValue = tgt[$getByIndex](index);
    const value = decodeValue(
        decoder,
        operation,
        ref,
        index,
        previousValue,
        type,
        bytes,
        it,
        allChanges,
    );

    if (
        value !== null && value !== undefined &&
        value !== previousValue // avoid setting same value twice (if index === 0 it will result in a "unshift" for ArraySchema)
    ) {
        tgt.$setAt(index, value, operation);
    }

    // add change
    if (previousValue !== value) {
        allChanges?.push({
            ref,
            refId: decoder.currentRefId,
            op: operation,
            dynamicIndex,
            value,
            previousValue,
        });
    }
}