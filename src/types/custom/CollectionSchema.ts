import { $changes, $childType, $decoder, $deleteByIndex, $encoder, $filter, $getByIndex, $onEncodeEnd, $refId } from "../symbols.js";
import { ChangeTree, type IRef } from "../../encoder/ChangeTree.js";
import { OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation.js";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation.js";
import type { StateView } from "../../encoder/StateView.js";
import type { Schema } from "../../Schema.js";

type K = number; // TODO: allow to specify K generic on MapSchema.

export class CollectionSchema<V=any> implements Collection<K, V>, IRef {
    [$changes]: ChangeTree;
    [$refId]?: number;

    protected [$childType]: string | typeof Schema;

    /** The user-visible data, keyed directly by the wire-protocol index. */
    protected $items: Map<number, V> = new Map<number, V>();

    /** Snapshots of values that were deleted this tick (for filter visibility). */
    protected deletedItems: { [field: string]: V } = {};

    /** Monotonic counter for assigning indexes to newly-added items. */
    protected $refId: number = 0;

    static [$encoder] = encodeKeyValueOperation;
    static [$decoder] = decodeKeyValueOperation;

    /**
     * Determine if a property must be filtered.
     * - If returns false, the property is NOT going to be encoded.
     * - If returns true, the property is going to be encoded.
     *
     * Encoding with "filters" happens in two steps:
     * - First, the encoder iterates over all "not owned" properties and encodes them.
     * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
     */
    static [$filter] (ref: CollectionSchema, index: number, view: StateView) {
        return (
            !view ||
            typeof (ref[$childType]) === "string" ||
            view.isChangeTreeVisible((ref[$getByIndex](index) ?? ref.deletedItems[index])[$changes])
        );
    }

    static is(type: any) {
        return type['collection'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
        Object.defineProperty(this, $changes, {
            value: new ChangeTree(this),
            enumerable: false,
            writable: true,
        });
        Object.defineProperty(this, $childType, {
            value: undefined,
            enumerable: false,
            writable: true,
            configurable: true,
        });

        if (initialValues) {
            initialValues.forEach((v) => this.add(v));
        }
    }

    add(value: V) {
        // assign the next wire-protocol index
        const index = this.$refId++;

        const isRef = (value[$changes]) !== undefined;
        if (isRef) {
            value[$changes].setParent(this, this[$changes].root, index);
        }

        this.$items.set(index, value);

        this[$changes].change(index);

        return index;
    }

    at(index: number): V | undefined {
        const key = Array.from(this.$items.keys())[index];
        return this.$items.get(key);
    }

    entries() {
        return this.$items.entries();
    }

    delete(item: V) {
        const entries = this.$items.entries();

        let index: K;
        let entry: IteratorResult<[number, V]>;
        while (entry = entries.next()) {
            if (entry.done) { break; }

            if (item === entry.value[1]) {
                index = entry.value[0];
                break;
            }
        }

        if (index === undefined) {
            return false;
        }

        this.deletedItems[index] = this[$changes].delete(index);

        return this.$items.delete(index);
    }

    clear() {
        const changeTree = this[$changes];

        // discard previous operations.
        changeTree.discard(true);

        // remove children references
        changeTree.forEachChild((childChangeTree, _) => {
            changeTree.root?.remove(childChangeTree);
        });

        // clear items
        this.$items.clear();

        changeTree.operation(OPERATION.CLEAR);
    }

    has (value: V): boolean {
        return Array.from(this.$items.values()).some((v) => v === value);
    }

    forEach(callbackfn: (value: V, key: K, collection: CollectionSchema<V>) => void) {
        this.$items.forEach((value, key, _) => callbackfn(value, key, this));
    }

    values() {
        return this.$items.values();
    }

    get size () {
        return this.$items.size;
    }

    /** Iterator */
    [Symbol.iterator](): IterableIterator<V> {
        return this.$items.values();
    }

    // ────────────────────────────────────────────────────────────────────
    // Decoder-side index hooks. CollectionSchema's "key" IS the wire index,
    // so these are identity operations. Kept for protocol symmetry with
    // MapSchema (decoder calls them polymorphically).
    // ────────────────────────────────────────────────────────────────────

    protected setIndex(_index: number, _key: number) {
        // no-op: indexes are identity
    }

    protected getIndex(index: number): number {
        return index;
    }

    [$getByIndex](index: number): any {
        return this.$items.get(index);
    }

    [$deleteByIndex](index: number): void {
        this.$items.delete(index);
    }

    protected [$onEncodeEnd]() {
        for (const key in this.deletedItems) { delete this.deletedItems[key]; }
    }

    toArray() {
        return Array.from(this.$items.values());
    }

    toJSON() {
        const values: V[] = [];

        this.forEach((value: any, key: K) => {
            values.push(
                (typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value
            );
        });

        return values;
    }

    //
    // Decoding utilities
    //
    clone(isDecoding?: boolean): CollectionSchema<V> {
        let cloned: CollectionSchema;

        if (isDecoding) {
            // client-side
            cloned = Object.assign(new CollectionSchema(), this);

        } else {
            // server-side
            cloned = new CollectionSchema();
            this.forEach((value: any) => {
                if (value[$changes]) {
                    cloned.add(value['clone']());
                } else {
                    cloned.add(value);
                }
            })
        }

        return cloned;
    }

}

registerType("collection", { constructor: CollectionSchema, });
