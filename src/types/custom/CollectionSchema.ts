import { CollectionKind } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { SetSchema } from "./SetSchema.js";

let warned = false;

/**
 * @deprecated `CollectionSchema` is a `SetSchema` that allows duplicate
 * values. Use `SetSchema` (unique values), `ArraySchema` (ordered) or
 * `MapSchema` (keyed) instead. Kept as a thin subclass so
 * `t.collection()` / `{ collection: X }` keep working; it will be removed
 * in a future major version.
 */
export class CollectionSchema<V=any> extends SetSchema<V> {
    static readonly COLLECTION_KIND: CollectionKind = CollectionKind.Collection;

    static is(type: any) {
        return type['collection'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
        if (!warned) {
            warned = true;
            console.warn("@colyseus/schema: CollectionSchema is deprecated — use SetSchema, ArraySchema or MapSchema instead.");
        }
        super(initialValues);
    }

    /** Duplicates are allowed: every call appends a new entry. */
    add(value: V): number {
        return this.$add(value);
    }

    /** Nth entry in insertion order (O(n)). */
    at(index: number): V | undefined {
        let i = 0;
        for (const value of this.$items.values()) {
            if (i++ === index) return value;
        }
        return undefined;
    }

    /** True iff any entry is `value` (O(n) — duplicates are allowed). */
    has(value: V): boolean {
        for (const v of this.$items.values()) {
            if (v === value) return true;
        }
        return false;
    }

    /** Remove the first entry equal to `item` (O(n) — duplicates are allowed). */
    delete(item: V): boolean {
        for (const [index, value] of this.$items) {
            if (value === item) return this.$deleteAt(index, value);
        }
        return false;
    }
}

registerType("collection", { constructor: CollectionSchema, });
