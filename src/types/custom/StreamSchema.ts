import { OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import {
    $changes,
    $childType,
    $decoder,
    $deleteByIndex,
    $encoder,
    $filter,
    $getByIndex,
    $onEncodeEnd,
    $refId,
} from "../symbols.js";
import { ChangeTree, type IRef } from "../../encoder/ChangeTree.js";
import { encodeIndexedEntry } from "../../encoder/EncodeOperation.js";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation.js";
import {
    createStreamableState,
    streamDropView,
    streamRouteAdd,
    streamRouteClear,
    streamRouteRemove,
    streamSeedView,
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
 * per-tick budget. Chain `.static()` on the field builder to suppress
 * post-add mutation tracking entirely.
 */
export class StreamSchema<V = any> implements IRef {
    [$changes]: ChangeTree;
    [$refId]?: number;

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
     * Brand used by Root / StateView to detect stream trees without
     * importing this class (avoids circular deps). The `isStreamCollection`
     * ChangeTree flag (set via `inheritedFlags`) is the preferred runtime
     * check — this brand is kept for back-compat.
     */
    static readonly $isStream: true = true;

    static [$encoder] = encodeIndexedEntry;
    static [$decoder] = decodeKeyValueOperation;

    /**
     * Element-level visibility. Identical to SetSchema's filter: stream
     * elements are always per-view, the filter just defers to the view's
     * per-tree visibility bitmap.
     */
    static [$filter](ref: StreamSchema, index: number, view: StateView) {
        if (!view) return true;
        const value = (ref as any)[$getByIndex](index);
        if (value === undefined) return false;
        return view.isVisible(value[$changes]);
    }

    static is(type: any): boolean {
        return type && type['stream'] !== undefined;
    }

    constructor() {
        Object.defineProperty(this, $changes, {
            value: new ChangeTree(this),
            enumerable: false,
            writable: true,
        });
        this[$childType] = undefined;
        // `isFiltered` / `isStreamCollection` are set via `inheritedFlags`
        // when this stream is attached to a parent field — no constructor-
        // time init needed (the stream tree is inert until assignment).
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

        const tree = this[$changes];
        const root = tree.root;

        // Attach element as a child — assigns $refId and wires the parent
        // chain so the element's own ChangeTree participates in encoding.
        if (value[$changes] !== undefined) {
            value[$changes].setParent(this, root, position);
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

        const root = this[$changes].root;
        if (root !== undefined) {
            streamRouteRemove(this, root, (this as any)[$refId], position);
            if (value[$changes] !== undefined) {
                root.remove((value as any)[$changes]);
            }
        }

        return true;
    }

    has(value: V): boolean {
        return this._itemIndex.has(value);
    }

    /** Remove every element; queue DELETE wire ops for already-sent items. */
    clear(): void {
        const root = this[$changes].root;
        if (root !== undefined) {
            streamRouteClear(this, root, (this as any)[$refId]);
            for (const el of this.$items.values()) {
                if (el[$changes] !== undefined) {
                    root.remove((el as any)[$changes]);
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

    // ────────────────────────────────────────────────────────────────────
    // Decoder / encoder plumbing — same shape as SetSchema so
    // {encode,decode}KeyValueOperation can route uniformly. StreamSchema
    // keys are identity (wire index === position), so `setIndex`/`getIndex`
    // are no-ops / identity like SetSchema.
    // ────────────────────────────────────────────────────────────────────

    protected setIndex(_index: number, _key: number): void {
        // no-op: indexes are identity
    }

    protected getIndex(index: number): number {
        return index;
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

    protected [$onEncodeEnd](): void {
        // No per-tick cleanup: pending/sent state spans encode ticks by design.
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

    clone(isDecoding?: boolean): StreamSchema<V> {
        if (isDecoding) {
            const cloned = Object.assign(new StreamSchema<V>(), this);
            return cloned;
        }
        const cloned = new StreamSchema<V>();
        cloned.maxPerTick = this.maxPerTick;
        this.forEach((v: any) => {
            cloned.add(typeof v?.clone === "function" ? v.clone() : v);
        });
        return cloned;
    }

    // ─── Streamable interface (Encoder priority / broadcast pass) ──────

    _seedViewPending(viewId: number): void {
        streamSeedView(this, viewId, this.$items.keys());
    }

    _dropView(viewId: number): void {
        streamDropView(this, viewId);
    }

    /** Called by Root.remove when the stream's refcount hits zero. */
    _unregister(): void {
        // no-op — `Root.unregisterStream` handles the Set removal.
    }
}

registerType("stream", { constructor: StreamSchema });
