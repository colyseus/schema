import { $changes, $childType, $decoder, $deleteByIndex, $encoder, $filter, $getByIndex, $onEncodeEnd, $refId } from "../symbols.js";
import { ChangeTree, installUntrackedChangeTree, type IRef } from "../../encoder/ChangeTree.js";
import { OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { CollectionKind, decodeKeyValueOperation } from "../../decoder/DecodeOperation.js";
import { encodeIndexedEntry } from "../../encoder/EncodeOperation.js";
import {
    createStreamableState,
    streamDropView,
    streamRouteAdd,
    streamRouteRemove,
    type StreamableState,
} from "../../encoder/streaming.js";
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

    /**
     * Streamable state — lazily allocated when the field is opted into
     * streaming via `t.collection(X).stream()`. See MapSchema for the
     * same pattern / rationale.
     */
    _stream?: StreamableState;

    get maxPerTick(): number {
        return this._stream?.maxPerTick ?? 32;
    }
    set maxPerTick(n: number) {
        (this._stream ??= createStreamableState()).maxPerTick = n;
    }

    get priority(): ((view: any, element: V) => number) | undefined {
        return this._stream?.priority as ((view: any, element: V) => number) | undefined;
    }
    set priority(fn: ((view: any, element: V) => number) | undefined) {
        (this._stream ??= createStreamableState()).priority = fn;
    }

    static [$encoder] = encodeIndexedEntry;
    static [$decoder] = decodeKeyValueOperation;
    /** Integer tag read by `decodeKeyValueOperation` — see `CollectionKind`. */
    static readonly COLLECTION_KIND = CollectionKind.Collection;

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
        // $changes must be non-enumerable — see Schema.initialize.
        Object.defineProperty(this, $changes, {
            value: new ChangeTree(this),
            enumerable: false,
            writable: true,
        });
        this[$childType] = undefined as any;

        if (initialValues) {
            initialValues.forEach((v) => this.add(v));
        }
    }

    /**
     * Decoder-side factory. Skips the tracking `ChangeTree` allocation;
     * `Object.create` also bypasses the class-field initializers, so we
     * replicate the minimum slot init here. Must stay in sync with the
     * class-field declarations above.
     */
    static initializeForDecoder<V = any>(): CollectionSchema<V> {
        const self: any = Object.create(CollectionSchema.prototype);
        self.$items = new Map<number, V>();
        self.deletedItems = {};
        self.$refId = 0;
        self[$childType] = undefined;
        installUntrackedChangeTree(self);
        return self;
    }

    add(value: V) {
        // assign the next wire-protocol index
        const index = this.$refId++;

        const changeTree = this[$changes];
        const isRef = (value[$changes]) !== undefined;
        if (isRef) {
            value[$changes].setParent(this, changeTree.root, index);
        }

        this.$items.set(index, value);

        if (changeTree.isStreamCollection) {
            if (changeTree.root !== undefined) {
                streamRouteAdd(this, changeTree.root, index);
            }
        } else {
            changeTree.change(index);
        }

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

        const changeTree = this[$changes];
        if (changeTree.isStreamCollection) {
            const root = changeTree.root;
            const previousValue = this.$items.get(index);
            if (root !== undefined) {
                streamRouteRemove(this, root, (this as any)[$refId], index);
            }
            if ((previousValue as any)?.[$changes] !== undefined) {
                root?.remove((previousValue as any)[$changes]);
            }
            this.deletedItems[index] = previousValue as V;
            return this.$items.delete(index);
        }

        this.deletedItems[index] = changeTree.delete(index);

        return this.$items.delete(index);
    }

    clear() {
        const changeTree = this[$changes];

        // discard previous operations.
        changeTree.discard();

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

    // ────── Change tracking control (same API as Schema) ──────
    pauseTracking(): void { this[$changes].pause(); }
    resumeTracking(): void { this[$changes].resume(); }
    untracked<T>(fn: () => T): T { return this[$changes].untracked(fn); }
    get isTrackingPaused(): boolean { return this[$changes].paused; }

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

    // ─── Streamable interface (Encoder priority / broadcast pass) ──────

    _dropView(viewId: number): void {
        streamDropView(this, viewId);
    }

    _unregister(): void {
        // no-op — `Root.unregisterStream` handles the Set removal.
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
