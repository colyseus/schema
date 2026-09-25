import { CollectionKind, OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { $changes, $childType, $deleteByIndex, $filter, $getByIndex, $onEncodeEnd, $recorder, $refId, $reset, $resyncPrune } from "../symbols.js";
import { Collection } from "../HelperTypes.js";
import { ChangeTree, installUntrackedChangeTree, type IRef, stampTree, treeOf, refTreeOf, defineRefAccessors } from "../../encoder/ChangeTree.js";
import { KeyedRecorder, freeIndex, releaseQuarantine } from "../../encoder/KeyedRecorder.js";
import {
    createStreamableState,
    streamDropView,
    streamRouteAdd,
    streamRouteRemove,
    type StreamableState,
} from "../../encoder/streaming.js";
import type { StateView } from "../../encoder/StateView.js";
import type { Schema } from "../../Schema.js";

/**
 * SetSchema — unordered collection of unique values, keyed on the wire by an
 * index (one freed in an earlier tick, else `nextIndex++`; see
 * `$onEncodeEnd`). `indexByValue` gives O(1) `has` / `delete`.
 */
export class SetSchema<V=any> implements Collection<number, V>, IRef {
    /** Prototype accessors over the private tree slot — see `defineRefAccessors`. */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;

    protected [$childType]: string | typeof Schema;

    /** The user-visible data, keyed directly by the wire-protocol index. */
    protected $items: Map<number, V> = new Map<number, V>();

    /** Reverse lookup (value → wire index) for O(1) `has` / `delete`. */
    protected indexByValue: Map<V, number> = new Map<V, number>();

    /** Next never-used wire index (freed indexes are reused first). */
    protected nextIndex: number = 0;

    /**
     * Streamable state — lazily allocated when the field is opted into
     * streaming via `t.set(X).stream()`. See MapSchema for the same
     * pattern / rationale.
     */
    _stream?: StreamableState;

    /** Max ADD ops emitted per tick per view. Ignored outside streaming mode. */
    get maxPerTick(): number {
        return this._stream?.maxPerTick ?? 32;
    }
    set maxPerTick(n: number) {
        (this._stream ??= createStreamableState()).maxPerTick = n;
    }

    /** Per-view priority callback — see StreamSchema / MapSchema. */
    get priority(): ((view: any, element: V) => number) | undefined {
        return this._stream?.priority as ((view: any, element: V) => number) | undefined;
    }
    set priority(fn: ((view: any, element: V) => number) | undefined) {
        (this._stream ??= createStreamableState()).priority = fn;
    }

    static [$recorder] = () => new KeyedRecorder();
    static readonly COLLECTION_KIND: CollectionKind = CollectionKind.Set;

    /** Per-entry visibility for `StateView` encodes (removed values resolve through the recorder). */
    static [$filter] (ref: SetSchema, index: number, view: StateView) {
        if (!view || typeof (ref[$childType]) === "string") return true;
        const value: any = ref.$items.get(index) ?? (refTreeOf(ref).rec as KeyedRecorder | undefined)?.deleted?.get(index);
        return value !== undefined && view.isVisible(refTreeOf(value));
    }

    static is(type: any) {
        return type['set'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
        stampTree(this, new ChangeTree(this));
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
    static initializeForDecoder<V = any>(): SetSchema<V> {
        const self: any = Object.create(this.prototype);
        self.$items = new Map<number, V>();
        self.indexByValue = new Map<V, number>();
        self.nextIndex = 0;
        self[$childType] = undefined;
        installUntrackedChangeTree(self);
        return self;
    }

    add(value: V) {
        // immediately return false if value already added.
        if (this.indexByValue.has(value)) { return false; }
        return this.$add(value);
    }

    /** Shared by `add` and the duplicate-allowing `CollectionSchema.add`. */
    protected $add(value: V): number {
        const tree = treeOf(this);
        const free = (tree.rec as KeyedRecorder | undefined)?.free;
        const index = (free !== undefined && free.length !== 0) ? free.pop()! : this.nextIndex++;

        this.$items.set(index, value);
        this.indexByValue.set(value, index);

        // Streaming-mode ADD: route into per-view or broadcast pending
        // instead of the tree's recorder. See MapSchema.set for the same
        // branch / rationale.
        if (tree.isStreamCollection) {
            if (tree.root !== undefined) {
                streamRouteAdd(this, tree.root, index);
            }
        } else if (tree.tracking) {
            (tree.rec as KeyedRecorder).add(index, OPERATION.ADD);
            tree.touch();
        }

        // set the parent AFTER recording (the parent's op precedes the child's chunk)
        if (refTreeOf(value) !== undefined) {
            refTreeOf(value).setParent(this, tree.root, index, tree);
        }
        return index;
    }

    entries () {
        return this.$items.entries();
    }

    delete(item: V) {
        const index = this.indexByValue.get(item);
        if (index === undefined) {
            return false;
        }
        return this.$deleteAt(index, item);
    }

    protected $deleteAt(index: number, previousValue: V): boolean {
        const tree = treeOf(this);
        const previousTree = refTreeOf(previousValue);

        // Streaming-mode: route through stream's pending/sent bookkeeping
        // — silent drop if never sent to any view, force DELETE for views
        // that already received it. Mirror of MapSchema.delete's streaming
        // branch.
        if (tree.isStreamCollection) {
            const root = tree.root;
            let neverSent = false;
            if (root !== undefined) {
                neverSent = streamRouteRemove(this, root, tree.refId!, index);
            }
            if (previousTree !== undefined) {
                root?.remove(previousTree);
            }
            if (!neverSent) (tree.rec as KeyedRecorder | undefined)?.remember(index, previousValue);

        } else {
            if (tree.tracking) {
                (tree.rec as KeyedRecorder).delete(index, previousValue);
                tree.touch();
            }
            if (previousTree !== undefined) tree.root?.remove(previousTree);
        }

        this.$items.delete(index);
        if (this.indexByValue.get(previousValue) === index) this.indexByValue.delete(previousValue);
        return true;
    }

    clear() {
        const tree = treeOf(this);

        // remove children references
        tree.forEachChild((childChangeTree, _) => {
            tree.root?.remove(childChangeTree);
        });

        this.$items.clear();
        this.indexByValue.clear();
        // numbering continues from `nextIndex` (a view may still hold entries
        // for the old indexes), so the free indexes go
        const rec = tree.rec as KeyedRecorder | undefined;
        if (rec !== undefined) rec.free = rec.quarantine = undefined;

        if (tree.tracking) {
            (tree.rec as KeyedRecorder).clear();
            tree.touch();
        }
    }

    /**
     * End of tick: an index whose entry was removed this tick (and not re-added)
     * and whose DELETE shipped is reused from the next tick on — see
     * `freeIndex`. `discard` (`shipped` false) frees nothing: the client may
     * still hold the index. Streamed sets never recycle.
     */
    protected [$onEncodeEnd](shipped: boolean) {
        const tree = treeOf(this);
        const rec = tree.rec as KeyedRecorder | undefined;
        if (rec === undefined || !shipped || tree.root === undefined || tree.isStreamCollection) return;
        releaseQuarantine(rec, tree.root, tree.refId!);
        if (rec.deleted === undefined) return;
        for (const index of rec.deleted.keys()) {
            if (!this.$items.has(index)) freeIndex(rec, tree.root, tree.refId!, index);
        }
    }

    /**
     * Pool reset: empty this set and recycle its ChangeTree WITHOUT recording
     * any wire op (the parent field's ADD/DELETE owns the wire). Recurses into
     * ref-type children. Called by Schema.reset when a pooled entity has a set
     * field. The instance must already be detached from the encoder.
     */
    [$reset]() {
        const tree = treeOf(this);
        if (tree.isStreamCollection) {
            throw new Error(`@colyseus/schema: cannot reset a streamed ${this.constructor.name} (pooling not supported).`);
        }
        this.$items.forEach((value: any) => value?.[$reset]?.());
        this.$items.clear();
        this.indexByValue.clear();
        this.nextIndex = 0;
        tree.recycle();
    }

    has (value: V): boolean {
        return this.indexByValue.has(value);
    }

    forEach(callbackfn: (value: V, key: number, collection: SetSchema<V>) => void) {
        this.$items.forEach((value, key, _) => callbackfn(value, key, this));
    }

    values() {
        return this.$items.values();
    }

    get size () {
        return this.$items.size;
    }

    // ────── Change tracking control (same API as Schema) ──────
    pauseTracking(): void { treeOf(this).pause(); }
    resumeTracking(): void { treeOf(this).resume(); }
    untracked<T>(fn: () => T): T { return treeOf(this).untracked(fn); }
    get isTrackingPaused(): boolean { return treeOf(this).paused; }

    /** Iterator */
    [Symbol.iterator](): IterableIterator<V> {
        return this.$items.values();
    }

    [$getByIndex](index: number): any {
        return this.$items.get(index);
    }

    [$deleteByIndex](index: number): void {
        const value = this.$items.get(index);
        this.$items.delete(index);
        if (value !== undefined && this.indexByValue.get(value) === index) this.indexByValue.delete(value);
    }

    [$resyncPrune](
        visited: Set<number | string>,
        prune: (value: V, identity: number | string) => void,
        keep: (value: V) => void,
    ): void {
        let toDelete: number[] | null = null;
        this.$items.forEach((value, index) => {
            if (visited.has(index)) { keep(value); return; }
            (toDelete ??= []).push(index);
            prune(value, index);
        });
        if (toDelete !== null) {
            for (let i = 0; i < toDelete.length; i++) { this[$deleteByIndex](toDelete[i]); }
        }
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

        this.forEach((value: any, key: number) => {
            values.push(
                (typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value
            );
        });

        return values;
    }

    clone(): this {
        const cloned = new (this.constructor as any)();
        this.forEach((value: any) => {
            cloned.add((refTreeOf(value) !== undefined) ? value.clone() : value);
        });
        return cloned;
    }

}

registerType("set", { constructor: SetSchema });

defineRefAccessors(SetSchema.prototype);
