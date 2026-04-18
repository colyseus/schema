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
     * Per-view ADD backlog: positions never sent to that view yet.
     * Populated on `add()` for every currently-active view, and on
     * StateView join via the bootstrap seed.
     */
    _pendingByView: Map<number, Set<number>> = new Map();

    /** Per-view SENT set, used to decide whether `remove()` emits a DELETE. */
    _sentByView: Map<number, Set<number>> = new Map();

    /**
     * Broadcast-mode backlog. Used only when no StateView is registered on
     * the Root — `Encoder.encode()` drains up to `maxPerTick` entries per
     * shared tick. `_sentBroadcast` tracks already-emitted positions so
     * `remove()` can decide between silent-drop and forced DELETE.
     *
     * Broadcast and view modes are mutually exclusive over a stream's
     * lifetime — switching modes mid-room drops any unsent pending for
     * the outgoing mode.
     */
    _broadcastPending: Set<number> = new Set();
    _sentBroadcast: Set<number> = new Set();
    _broadcastDeletes: Set<number> = new Set();

    /** Per-view max element ADDs emitted per encode tick. */
    maxPerTick: number = 32;

    /** Registered with Root's stream set once attached to a parent. */
    private _registered: boolean = false;

    /**
     * Brand used by Root / StateView to detect stream trees without
     * importing this class (avoids circular deps).
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
        this[$childType] = undefined as any;

        // Streams are inherently view-scoped — elements must never emit on
        // the shared (unfiltered) channel. Child element trees inherit
        // `isFiltered` through the normal parent-chain flag inheritance.
        this[$changes].isFiltered = true;
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
        if ((value as any)[$changes] !== undefined) {
            (value as any)[$changes].setParent(this, root, position);
        }

        if (root !== undefined) {
            this._ensureRegistered(root);

            if (root.activeViews.size === 0) {
                // Broadcast mode — `Encoder.encode()` drains this set.
                this._broadcastPending.add(position);
            } else {
                // Per-view mode — priority pass drains per-view pending.
                const pendingByView = this._pendingByView;
                root.forEachActiveView((view) => {
                    const viewId = view.id;
                    let pending = pendingByView.get(viewId);
                    if (pending === undefined) {
                        pending = new Set();
                        pendingByView.set(viewId, pending);
                    }
                    pending.add(position);
                });
            }
        }

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

        const tree = this[$changes];
        const root = tree.root;
        if (root !== undefined) {
            // Broadcast-mode handling.
            if (this._broadcastPending.delete(position)) {
                // never sent — drop silently
            } else if (this._sentBroadcast.delete(position)) {
                this._broadcastDeletes.add(position);
            }

            // Per-view handling.
            const myRefId = (this as any)[$refId];
            root.forEachActiveView((view) => {
                const viewId = view.id;
                const pending = this._pendingByView.get(viewId);
                if (pending?.has(position)) {
                    pending.delete(position);
                    return; // never sent — drop silently
                }
                const sent = this._sentByView.get(viewId);
                if (sent?.has(position)) {
                    sent.delete(position);
                    // Force DELETE via view.changes (drained first in encodeView).
                    let changes = view.changes.get(myRefId);
                    if (changes === undefined) {
                        changes = new Map();
                        view.changes.set(myRefId, changes);
                    }
                    changes.set(position, OPERATION.DELETE);
                }
            });

            // Release the element's changeTree reference.
            if ((value as any)[$changes] !== undefined) {
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
        const tree = this[$changes];
        const root = tree.root;
        if (root !== undefined) {
            // Broadcast mode: drop never-sent pending; force DELETE for sent.
            this._broadcastPending.clear();
            for (const pos of this._sentBroadcast) this._broadcastDeletes.add(pos);
            this._sentBroadcast.clear();

            // Per-view mode.
            const myRefId = (this as any)[$refId];
            root.forEachActiveView((view) => {
                const viewId = view.id;
                this._pendingByView.get(viewId)?.clear();

                const sent = this._sentByView.get(viewId);
                if (sent !== undefined && sent.size > 0) {
                    let changes = view.changes.get(myRefId);
                    if (changes === undefined) {
                        changes = new Map();
                        view.changes.set(myRefId, changes);
                    }
                    for (const pos of sent) changes.set(pos, OPERATION.DELETE);
                    sent.clear();
                }
            });
            for (const el of this.$items.values()) {
                if ((el as any)[$changes] !== undefined) {
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

    // ────────────────────────────────────────────────────────────────────
    // Internal
    // ────────────────────────────────────────────────────────────────────

    /**
     * Seed `_pendingByView[view.id]` with every live position. Called by
     * StateView when the stream first becomes visible to a view — ensures
     * late-joining clients pick up the existing backlog.
     */
    _seedViewPending(viewId: number): void {
        let pending = this._pendingByView.get(viewId);
        if (pending === undefined) {
            pending = new Set();
            this._pendingByView.set(viewId, pending);
        }
        for (const position of this.$items.keys()) pending.add(position);
    }

    /**
     * Drop all per-view state for a view (on `view.dispose()`). Keeps
     * stream memory bounded in long-running rooms with client churn.
     */
    _dropView(viewId: number): void {
        this._pendingByView.delete(viewId);
        this._sentByView.delete(viewId);
    }

    private _ensureRegistered(root: any): void {
        if (this._registered) return;
        this._registered = true;
        root.registerStream(this);
    }

    /** Called by Root.remove when the stream's refcount hits zero. */
    _unregister(): void {
        this._registered = false;
    }
}

registerType("stream", { constructor: StreamSchema });
