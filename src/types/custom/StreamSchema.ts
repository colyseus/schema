import { CollectionKind } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import {
    $changes,
    $childType,
    $deleteByIndex,
    $filter,
    $getByIndex,
    $recorder,
    $refId,
    $resyncPrune,
} from "../symbols.js";
import { ChangeTree, installUntrackedChangeTree, type IRef, stampTree, treeOf, refTreeOf, defineRefAccessors, refIdOf } from "../../encoder/ChangeTree.js";
import { KeyedRecorder } from "../../encoder/KeyedRecorder.js";
import {
    createStreamableState,
    streamDropView,
    streamRouteAdd,
    streamRouteClear,
    streamRouteRemove,
    type StreamableState,
} from "../../encoder/streaming.js";
import type { StateView } from "../../encoder/StateView.js";
import type { Schema } from "../../Schema.js";

/**
 * `t.stream(Entity)` — priority-batched collection of Schema instances.
 *
 * Designed for ECS-style use cases where many entities spawn/despawn each
 * tick and the full set won't fit in one encode budget. Adds are queued
 * per-client and drained in priority order (callback on StateView) up to
 * `maxPerTick` per encode pass. Field mutations on already-sent elements
 * propagate through the normal reliable channel without consuming the
 * per-tick budget. Chain `.fullStateOnly()` on the field builder to suppress
 * post-add mutation tracking entirely.
 */
export class StreamSchema<V = any> implements IRef {
    /** Prototype accessors over the private tree slot — see `defineRefAccessors`. */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;

    protected [$childType]: string | typeof Schema;

    /**
     * Wire-keyed storage: `position → element`. Position is a monotonic
     * counter assigned by `add()` — stable identity even when elements
     * are removed, so pending/sent view state can keep using the same
     * keys across ticks. Map (not Array) so `$items.keys()` / `.values()`
     * skip removed positions without a sparse-slot check.
     */
    protected $items: Map<number, V> = new Map();

    /** Monotonic position counter. Incremented on every `add()`. */
    protected $nextPosition: number = 0;

    /** Reverse lookup for O(1) `remove(el)`. */
    protected _itemIndex: Map<V, number> = new Map();

    /**
     * Streamable state — holds per-view and broadcast bookkeeping. Lazily
     * allocated when the stream is attached to a Root (or when the user
     * touches `maxPerTick`). `undefined` on detached streams so
     * construction is cheap.
     */
    _stream?: StreamableState;

    /** Max element ADDs emitted per encode tick (per view, or broadcast). */
    get maxPerTick(): number {
        return this._stream?.maxPerTick ?? 32;
    }
    set maxPerTick(n: number) {
        (this._stream ??= createStreamableState()).maxPerTick = n;
    }

    /**
     * Per-view priority callback. Initialized from the schema declaration
     * (`.priority(fn)` or `@type({ stream, priority })`); assigning here
     * overrides the class-level default for this instance. Only fires
     * during `encodeView` — broadcast mode drains FIFO.
     */
    get priority(): ((view: any, element: V) => number) | undefined {
        return this._stream?.priority as ((view: any, element: V) => number) | undefined;
    }
    set priority(fn: ((view: any, element: V) => number) | undefined) {
        (this._stream ??= createStreamableState()).priority = fn;
    }

    /**
     * Brand used by Root / StateView to detect stream trees without
     * importing this class (avoids circular deps). The `isStreamCollection`
     * ChangeTree flag (set via `inheritedFlags`) is the preferred runtime
     * check — this brand is kept for back-compat.
     */
    static readonly $isStream: true = true;

    static [$recorder] = () => new KeyedRecorder();
    static readonly COLLECTION_KIND = CollectionKind.Stream;

    /**
     * Element-level visibility. Identical to SetSchema's filter: stream
     * elements are always per-view, the filter just defers to the view's
     * per-tree visibility bitmap.
     */
    static [$filter](ref: StreamSchema, index: number, view: StateView) {
        if (!view) return true;
        const value = (ref as any)[$getByIndex](index);
        if (value === undefined) return false;
        return view.isVisible(refTreeOf(value));
    }

    static is(type: any): boolean {
        return type && type['stream'] !== undefined;
    }

    constructor() {
        stampTree(this, new ChangeTree(this));
        this[$childType] = undefined;
        // `isFiltered` / `isStreamCollection` are set via `inheritedFlags`
        // when this stream is attached to a parent field — no constructor-
        // time init needed (the stream tree is inert until assignment).
    }

    /**
     * Decoder-side factory. Skips the tracking `ChangeTree` allocation;
     * `Object.create` also bypasses the class-field initializers, so we
     * replicate the minimum slot init here. Must stay in sync with the
     * class-field declarations above.
     */
    static initializeForDecoder<V = any>(): StreamSchema<V> {
        const self: any = Object.create(StreamSchema.prototype);
        self.$items = new Map<number, V>();
        self.$nextPosition = 0;
        self._itemIndex = new Map();
        self[$childType] = undefined;
        installUntrackedChangeTree(self);
        return self;
    }

    /**
     * Append an element to the stream. Returns the assigned position,
     * or -1 if the element was already in the stream.
     */
    add(value: V): number {
        if (this._itemIndex.has(value)) return -1;

        const position = this.$nextPosition++;
        this.$items.set(position, value);
        this._itemIndex.set(value, position);

        const tree = treeOf(this);
        const root = tree.root;

        // Attach element as a child — assigns $refId and wires the parent
        // chain so the element's own ChangeTree participates in encoding.
        if (refTreeOf(value) !== undefined) {
            refTreeOf(value).setParent(this, root, position, tree);
        }

        if (root !== undefined) streamRouteAdd(this, root, position);
        return position;
    }

    /**
     * Remove an element by reference. If the element was pending (never sent
     * to a view), the pending entry is dropped silently. If already sent,
     * a DELETE op is forced on next `encodeView` for that view.
     */
    remove(value: V): boolean {
        const position = this._itemIndex.get(value);
        if (position === undefined) return false;

        this._itemIndex.delete(value);
        this.$items.delete(position);

        const root = treeOf(this).root;
        if (root !== undefined) {
            streamRouteRemove(this, root, refIdOf(this), position);
            if (refTreeOf(value) !== undefined) {
                root.remove(refTreeOf(value));
            }
        }

        return true;
    }

    has(value: V): boolean {
        return this._itemIndex.has(value);
    }

    /** Remove every element; queue DELETE wire ops for already-sent items. */
    clear(): void {
        const root = treeOf(this).root;
        if (root !== undefined) {
            streamRouteClear(this, root, refIdOf(this));
            for (const el of this.$items.values()) {
                if (refTreeOf(el) !== undefined) {
                    root.remove(refTreeOf(el));
                }
            }
        }
        this.$items.clear();
        this._itemIndex.clear();
    }

    forEach(callback: (value: V, index: number, collection: StreamSchema<V>) => void): void {
        for (const [index, value] of this.$items) callback(value, index, this);
    }

    values(): IterableIterator<V> {
        return this.$items.values();
    }

    /**
     * Iterate `[position, value]` pairs in insertion order. Used by
     * `setParent` recursion when the stream is reassigned to a new parent.
     */
    entries(): IterableIterator<[number, V]> {
        return this.$items.entries();
    }

    [Symbol.iterator](): IterableIterator<V> {
        return this.$items.values();
    }

    /** Live element count. */
    get size(): number {
        return this.$items.size;
    }

    /** Alias for `size`. */
    get length(): number {
        return this.$items.size;
    }

    [$getByIndex](index: number): V {
        return this.$items.get(index) as V;
    }

    [$deleteByIndex](index: number): void {
        const value = this.$items.get(index);
        if (value !== undefined) {
            this._itemIndex.delete(value);
            this.$items.delete(index);
        }
    }

    [$resyncPrune](): void {
        // Stream contents are delivered by the trickle/priority pass, NOT
        // by full-sync (encodeAll carries none of them) — a snapshot is not
        // authoritative for streams, so absence ≠ deleted. Never prune.
    }

    toArray(): V[] {
        return Array.from(this.$items.values());
    }

    toJSON(): any[] {
        const out: any[] = [];
        this.forEach((v: any) => {
            out.push(typeof v?.toJSON === "function" ? v.toJSON() : v);
        });
        return out;
    }

    clone(): StreamSchema<V> {
        const cloned = new StreamSchema<V>();
        cloned.maxPerTick = this.maxPerTick;
        this.forEach((v: any) => {
            cloned.add(typeof v?.clone === "function" ? v.clone() : v);
        });
        return cloned;
    }

    // ─── Streamable interface (Encoder priority / broadcast pass) ──────

    _dropView(viewId: number): void {
        streamDropView(this, viewId);
    }

    /** Called by Root.remove when the stream's refcount hits zero. */
    _unregister(): void {
        // no-op — `Root.unregisterStream` handles the Set removal.
    }
}

registerType("stream", { constructor: StreamSchema });

defineRefAccessors(StreamSchema.prototype);
