import { $applyKeyType, $changes, $childType, $deleteByIndex, $onEncodeEnd, $filter, $getByIndex, $keyType, $recorder, $refId, $reset, $resyncPrune } from "../symbols.js";
import { RefTable } from "../../RefTable.js";
import type { MapKeyType } from "../../annotations.js";
import { ChangeTree, installUntrackedChangeTree, IRef, stampTree, treeOf, refTreeOf, defineRefAccessors } from "../../encoder/ChangeTree.js";
import { KeyedRecorder } from "../../encoder/KeyedRecorder.js";
import { CollectionKind, OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import {
    createStreamableState,
    streamDropView,
    streamRouteAdd,
    streamRouteRemove,
    type StreamableState,
} from "../../encoder/streaming.js";
import type { StateView } from "../../encoder/StateView.js";
import type { Schema } from "../../Schema.js";
import { assertInstanceType } from "../../encoding/assert.js";

export class MapSchema<V=any, K extends string | number = string> implements Map<K, V>, Collection<K, V, [K, V]>, IRef {
    /** Prototype accessors over the private tree slot — see `defineRefAccessors`. */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;

    protected childType: new () => V;
    protected [$childType]: string | typeof Schema;

    /**
     * Declared key type (`"string"` / `"number"` / numeric primitive name).
     * `undefined` until the map is attached to a typed field: keys are then
     * stringified (legacy behavior) and re-keyed at attach time if the field
     * declares a numeric key.
     */
    [$keyType]: MapKeyType | undefined;

    protected $items: Map<K, V> = new Map<K, V>();

    /**
     * Wire identity. A key gets a monotonic wire index the first time it is
     * set; ops after the ADD address the entry by that index. Both sides
     * keep both directions: the encoder needs key → index to record, and
     * index → key to emit the key on ADD; the decoder needs index → key to
     * resolve ops. Mappings of removed keys are purged at the end of the
     * tick they were removed in (`$onEncodeEnd`).
     */
    /** Wire index → key. Indexes are handed out in order and never recycled: an array-backed table, not a hash map (see `RefTable`). */
    keyByIndex: RefTable<K> = new RefTable<K>();
    indexByKey: Map<K, number> = new Map();
    nextIndex: number = 0;

    /**
     * Streamable state — lazily allocated by `inheritedFlags` (or the
     * `maxPerTick` setter) when streaming actually activates. `undefined`
     * on every non-streaming MapSchema so the common case pays zero
     * Map/Set allocation. Single slot → hidden-class shape stays stable
     * across streaming and non-streaming instances.
     */
    _stream?: StreamableState;

    /** Max ADD ops emitted per tick per view. Ignored outside streaming mode. */
    get maxPerTick(): number {
        return this._stream?.maxPerTick ?? 32;
    }
    set maxPerTick(n: number) {
        (this._stream ??= createStreamableState()).maxPerTick = n;
    }

    /**
     * Per-view priority callback for `.stream()` maps. Initialized from the
     * schema declaration (`t.map(X).stream().priority(fn)` or `@type({ map,
     * priority })`); assigning here overrides for this instance. Only fires
     * during `encodeView` — broadcast mode drains FIFO.
     */
    get priority(): ((view: any, element: V) => number) | undefined {
        return this._stream?.priority as ((view: any, element: V) => number) | undefined;
    }
    set priority(fn: ((view: any, element: V) => number) | undefined) {
        (this._stream ??= createStreamableState()).priority = fn;
    }

    static [$recorder] = () => new KeyedRecorder();
    static readonly COLLECTION_KIND = CollectionKind.Map;

    /**
     * Per-entry visibility for `StateView` encodes. A value removed this
     * tick is resolved through the recorder's `deleted` snapshot.
     */
    static [$filter] (ref: MapSchema, index: number, view: StateView) {
        if (!view || typeof (ref[$childType]) === "string") return true;
        const value = ref[$getByIndex](index) ?? (refTreeOf(ref).rec as KeyedRecorder | undefined)?.deleted?.get(index);
        return value !== undefined && view.isChangeTreeVisible(refTreeOf(value));
    }

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<K, V> | Record<K, V>) {
        stampTree(this, new ChangeTree(this));
        this[$childType] = undefined as any;
        this[$keyType] = undefined;

        if (initialValues) {
            if (
                initialValues instanceof Map ||
                initialValues instanceof MapSchema ||
                (initialValues.constructor as any)?.COLLECTION_KIND === CollectionKind.Map // another library copy
            ) {
                (initialValues as Map<K, V>).forEach((v, k) => this.set(k, v));

            } else {
                for (const k in initialValues) {
                    this.set(k, initialValues[k]);
                }
            }
        }
    }

    /**
     * Decoder-side factory. Skips the tracking `ChangeTree` allocation;
     * `Object.create` also bypasses the class-field initializers, so we
     * replicate the minimum slot init here. Must stay in sync with the
     * class-field declarations above and with the constructor body.
     */
    static initializeForDecoder<V = any, K extends string | number = string>(): MapSchema<V, K> {
        const self: any = Object.create(MapSchema.prototype);
        self.$items = new Map<K, V>();
        self.keyByIndex = new RefTable();
        self.indexByKey = new Map();
        self.nextIndex = 0;
        self[$childType] = undefined;
        self[$keyType] = undefined;
        installUntrackedChangeTree(self);
        return self;
    }

    /**
     * Attach-time hook (field setter / auto-conversion): declare the key
     * type. Entries set before the map was attached were stringified; when
     * the field declares a numeric key they are re-keyed in place, keeping
     * each entry's wire index (recorder ops and child parent indexes are
     * index-based, so anything pending stays valid). No-op when empty.
     */
    [$applyKeyType](keyType: MapKeyType | undefined) {
        this[$keyType] = keyType;
        if (this.$items.size === 0 || keyType === undefined) return;
        const wantNumber = keyType !== "string";
        let needsRekey = false;
        for (const key of this.$items.keys()) {
            if ((typeof key === "number") !== wantNumber) { needsRekey = true; break; }
        }
        if (!needsRekey) return;

        const items = new Map<K, V>();
        const indexByKey = new Map<K, number>();
        const keyByIndex = new RefTable<K>();
        for (const [key, value] of this.$items) {
            const index = this.indexByKey.get(key)!;
            const newKey = coerceKey<K>(keyType, key);
            items.set(newKey, value);
            indexByKey.set(newKey, index);
            keyByIndex.set(index, newKey);
        }
        this.$items = items;
        this.indexByKey = indexByKey;
        this.keyByIndex = keyByIndex;
    }

    /** Iterator */
    [Symbol.iterator](): ReturnType<Map<K, V>[typeof Symbol.iterator]> { return this.$items[Symbol.iterator](); }
    get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag] }

    static get [Symbol.species]() { return MapSchema; }

    set(key: K, value: V) {
        if (value === undefined || value === null) {
            throw new Error(`MapSchema#set('${key}', ${value}): trying to set ${value} value on '${key}'.`);

        } else if (typeof(value) === "object" && this[$childType]) {
            assertInstanceType(value as any, this[$childType] as typeof Schema, this, key);
        }

        // Coerce the key to the declared key type. String (or not yet
        // attached): force "key" as string —
        // https://github.com/colyseus/colyseus/issues/561#issuecomment-1646733468
        // Inline fast paths: a key already of the declared type costs one typeof.
        const keyType = this[$keyType];
        if (keyType === undefined || keyType === "string") {
            if (typeof key !== "string") key = String(key) as K;
        } else if (typeof key !== "number" || key !== key) {
            key = coerceKey<K>(keyType, key);
        }

        const tree = treeOf(this);
        const isRef = refTreeOf(value) !== undefined;

        let index = this.indexByKey.get(key);
        let operation: OPERATION;

        if (index !== undefined) {
            operation = OPERATION.REPLACE;

            const previousValue = this.$items.get(key);
            if (previousValue === value) {
                // same value: nothing to encode
                return this;
            }

            if (isRef) {
                // a replaced ref must be released and re-introduced
                operation = OPERATION.DELETE_AND_ADD;
                if (previousValue !== undefined) {
                    tree.root?.remove(refTreeOf(previousValue));
                }
            }

            // re-set after a same-tick delete: the removed-value snapshot is moot
            (tree.rec as KeyedRecorder | undefined)?.forget(index);

        } else {
            index = this.nextIndex++;
            this.indexByKey.set(key, index);
            this.keyByIndex.set(index, key);
            operation = OPERATION.ADD;
        }

        this.$items.set(key, value);

        // Streaming-mode ADD: route the new entry into per-view or broadcast
        // pending instead of recording on the tree. The encoder's priority /
        // broadcast pass will drain up to `maxPerTick` per tick. REPLACE
        // and DELETE_AND_ADD fall through to the normal recorder path — the
        // old value is already being emitted, so the swap just mutates.
        if (operation === OPERATION.ADD && tree.isStreamCollection) {
            if (tree.root !== undefined) {
                streamRouteAdd(this, tree.root, index);
            }
        } else if (tree.tracking) {
            (tree.rec as KeyedRecorder).add(index, operation);
            tree.touch();
        }

        // set the parent AFTER recording (the parent's op precedes the child's chunk)
        if (isRef) {
            refTreeOf(value).setParent(this, tree.root, index, tree);
        }

        return this;
    }

    get(key: K): V | undefined {
        return this.$items.get(key);
    }

    /**
     * Returns the value for `key` if present. Otherwise inserts `defaultValue`
     * (tracked as an ADD change, like `set()`) and returns it.
     *
     * Mirrors `Map.prototype.getOrInsert` (TC39 "upsert" proposal, typed in
     * TypeScript 6's standard library).
     */
    getOrInsert(key: K, defaultValue: V): V {
        if (this.$items.has(key)) {
            return this.$items.get(key);
        }
        this.set(key, defaultValue);
        return defaultValue;
    }

    /**
     * Returns the value for `key` if present. Otherwise computes a value via
     * `callbackfn(key)`, inserts it (tracked as an ADD change, like `set()`)
     * and returns it. The callback is only invoked when the key is missing.
     *
     * Mirrors `Map.prototype.getOrInsertComputed` (TC39 "upsert" proposal,
     * typed in TypeScript 6's standard library).
     */
    getOrInsertComputed(key: K, callbackfn: (key: K) => V): V {
        if (this.$items.has(key)) {
            return this.$items.get(key);
        }
        const value = callbackfn(key);
        // per spec: overwrites even if callbackfn itself inserted `key`
        this.set(key, value);
        return value;
    }

    delete(key: K) {
        if (!this.$items.has(key)) {
            return false;
        }

        const index = this.indexByKey.get(key)!;
        const previousValue = this.$items.get(key)!;
        const tree = treeOf(this);
        const previousTree = refTreeOf(previousValue);

        // Streaming-mode: silent-drop if the entry never made it out to any
        // client (still in pending). Otherwise force DELETE on the channels
        // where it was already sent — bypasses the normal recorder so the
        // emission path stays symmetric with StreamSchema.
        if (tree.isStreamCollection) {
            const root = tree.root;
            let neverSent = false;
            if (root !== undefined) {
                neverSent = streamRouteRemove(this, root, tree.refId!, index);
            }
            if (previousTree !== undefined) {
                root?.remove(previousTree);
            }
            this.$items.delete(key);
            // Only snapshot if a DELETE op is actually pending (already-sent):
            // filter visibility checks look up the snapshot until the next
            // encode end. Never-sent entries can skip the snapshot work.
            if (!neverSent) (tree.rec as KeyedRecorder | undefined)?.remember(index, previousValue);
            return true;
        }

        if (tree.tracking) {
            (tree.rec as KeyedRecorder).delete(index, previousValue);
            tree.touch();
        }

        if (previousTree !== undefined) tree.root?.remove(previousTree);

        return this.$items.delete(key);
    }

    clear() {
        const tree = treeOf(this);

        // remove children references
        tree.forEachChild((childChangeTree, _) => {
            tree.root?.remove(childChangeTree);
        });

        // reset wire identity + storage
        this.keyByIndex.clear();
        this.indexByKey.clear();
        this.nextIndex = 0;
        this.$items.clear();

        // CLEAR is absorbing: pending ops are dropped, CLEAR is emitted first
        if (tree.tracking) {
            (tree.rec as KeyedRecorder).clear();
            tree.touch();
        }
    }

    /**
     * Pool reset: empty this map and recycle its ChangeTree WITHOUT recording
     * any wire op (the parent field's ADD/DELETE owns the wire). Recurses into
     * ref-type children. Called by Schema.reset when a pooled entity has a
     * map field. The instance must already be detached from the encoder.
     */
    [$reset]() {
        const tree = treeOf(this);
        if (tree.isStreamCollection) {
            throw new Error(`@colyseus/schema: cannot reset a streamed MapSchema (pooling not supported).`);
        }
        // reset ref-type children first (primitives optional-chain away)
        this.$items.forEach((value: any) => value?.[$reset]?.());
        this.$items.clear();
        this.keyByIndex.clear();
        this.indexByKey.clear();
        this.nextIndex = 0;
        tree.recycle();
    }

    has (key: K) {
        return this.$items.has(key);
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void) {
        this.$items.forEach(callbackfn);
    }

    entries () {
        return this.$items.entries();
    }

    keys () {
        return this.$items.keys();
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

    [$getByIndex](index: number): V | undefined {
        const key = this.keyByIndex.get(index);
        return key !== undefined ? this.$items.get(key) : undefined;
    }

    [$deleteByIndex](index: number): void {
        const key = this.keyByIndex.get(index);
        if (key !== undefined) {
            this.$items.delete(key);
            this.keyByIndex.delete(index);
            if (this.indexByKey.get(key) === index) this.indexByKey.delete(key);
        }
    }

    [$resyncPrune](
        visited: Set<number | string>,
        prune: (value: V, identity: number | string) => void,
        keep: (value: V) => void,
    ): void {
        // maps prune by string key, NOT wire index — the decoder-side
        // index → key table never evicts stale mappings on re-indexing.
        let deletedKeys: Set<K> | null = null;
        this.$items.forEach((value, key) => {
            if (visited.has(key)) { keep(value); return; }
            (deletedKeys ??= new Set()).add(key);
            prune(value, key);
        });
        if (deletedKeys !== null) {
            deletedKeys.forEach((key) => {
                this.$items.delete(key);
                this.indexByKey.delete(key);
            });
            // drop index→key mappings of swept keys — including stale ones
            // left behind by re-indexing.
            const staleIndexes: number[] = [];
            this.keyByIndex.forEach((key, index) => {
                if (deletedKeys!.has(key)) { staleIndexes.push(index); }
            });
            for (let i = 0; i < staleIndexes.length; i++) {
                this.keyByIndex.delete(staleIndexes[i]);
            }
        }
    }

    /**
     * End of tick: purge the wire identity of entries removed this tick
     * (their DELETE has shipped). Runs BEFORE the recorder reset, so
     * `rec.deleted` still lists them. A key re-set after its removal keeps
     * its index (`set` forgets the snapshot and the entry is live again).
     */
    protected [$onEncodeEnd](shipped: boolean) {
        const deleted = (treeOf(this).rec as KeyedRecorder | undefined)?.deleted;
        if (deleted === undefined) return;
        for (const index of deleted.keys()) {
            const key = this.keyByIndex.get(index);
            if (key !== undefined && this.indexByKey.get(key) === index && !this.$items.has(key)) {
                this.indexByKey.delete(key);
                this.keyByIndex.delete(index);
            }
        }
    }

    // ─── Streamable interface (Encoder priority / broadcast pass) ──────

    _dropView(viewId: number): void {
        streamDropView(this, viewId);
    }

    _unregister(): void {
        // no-op — `Root.unregisterStream` handles the Set removal.
    }

    toJSON() {
        const map: any = {};

        this.forEach((value: any, key) => {
            map[key] = (typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value;
        });

        return map;
    }

    clone(): MapSchema<V, K> {
        const cloned = new MapSchema<V, K>();
        cloned[$childType] = this[$childType];
        cloned[$keyType] = this[$keyType];
        this.forEach((value: any, key) => {
            cloned.set(key, (refTreeOf(value) !== undefined) ? value.clone() : value);
        });
        return cloned;
    }

}

/** Coerce a user-supplied key to the declared key type (string when undeclared). */
function coerceKey<K>(keyType: MapKeyType | undefined, key: any): K {
    if (keyType === undefined || keyType === "string") {
        return (typeof key === "string" ? key : String(key)) as K;
    }
    const n = (typeof key === "number") ? key : Number(key);
    if (n !== n) {
        throw new Error(`MapSchema#set(): key '${String(key)}' is not a valid ${keyType} key.`);
    }
    return n as K;
}

registerType("map", { constructor: MapSchema });

defineRefAccessors(MapSchema.prototype);
