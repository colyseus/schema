import { $changes, $childType, $decoder, $deleteByIndex, $onEncodeEnd, $encoder, $filter, $getByIndex, $refId } from "../symbols.js";
import { ChangeTree, IRef } from "../../encoder/ChangeTree.js";
import { OPERATION } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation.js";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation.js";
import { MapJournal } from "../../encoder/MapJournal.js";
import type { StateView } from "../../encoder/StateView.js";
import type { Schema } from "../../Schema.js";
import { assertInstanceType } from "../../encoding/assert.js";

export class MapSchema<V=any, K extends string = string> implements Map<K, V>, Collection<K, V, [K, V]>, IRef {
    [$changes]: ChangeTree;
    [$refId]?: number;

    protected childType: new () => V;
    protected [$childType]: string | typeof Schema;

    protected $items: Map<K, V> = new Map<K, V>();

    /**
     * Wire-protocol identity + change-tracking metadata for this map.
     *
     * Owns: index↔key mapping, monotonic index counter, snapshots of removed
     * values for filter visibility checks. Replaces what used to live as three
     * separate fields on this class ($indexes, _collectionIndexes, deletedItems).
     */
    protected journal: MapJournal<K> = new MapJournal<K>();

    /** Backwards-compat alias for `journal.keyByIndex`. */
    get $indexes(): Map<number, K> { return this.journal.keyByIndex; }

    /**
     * Backwards-compat alias for `journal.indexByKey`. Plain object so
     * polymorphic call sites like `ref._collectionIndexes?.[key]` keep working.
     */
    get _collectionIndexes(): { [key: string]: number } { return this.journal.indexByKey; }

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
    static [$filter] (ref: MapSchema, index: number, view: StateView) {
        if (!view || typeof (ref[$childType]) === "string") return true;
        const value = ref[$getByIndex](index) ?? ref.journal.snapshotAt(index);
        return view.isChangeTreeVisible(value[$changes]);
    }

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<K, V> | Record<K, V>) {
        // $changes MUST be non-enumerable — see Schema.initialize comment.
        // ChangeTree has circular refs (root→changeTrees→…) and would send
        // `assert.deepStrictEqual` into exponential recursion.
        Object.defineProperty(this, $changes, {
            value: new ChangeTree(this),
            enumerable: false,
            writable: true,
        });
        this[$childType] = undefined as any;

        if (initialValues) {
            if (
                initialValues instanceof Map ||
                initialValues instanceof MapSchema
            ) {
                initialValues.forEach((v, k) => this.set(k, v));

            } else {
                for (const k in initialValues) {
                    this.set(k, initialValues[k]);
                }
            }
        }
    }

    /** Iterator */
    [Symbol.iterator](): IterableIterator<[K, V]> { return this.$items[Symbol.iterator](); }
    get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag] }

    static get [Symbol.species]() { return MapSchema; }

    set(key: K, value: V) {
        if (value === undefined || value === null) {
            throw new Error(`MapSchema#set('${key}', ${value}): trying to set ${value} value on '${key}'.`);

        } else if (typeof(value) === "object" && this[$childType]) {
            assertInstanceType(value as any, this[$childType] as typeof Schema, this, key);
        }

        // Force "key" as string
        // See: https://github.com/colyseus/colyseus/issues/561#issuecomment-1646733468
        key = key.toString() as K;

        const changeTree = this[$changes];
        const isRef = (value[$changes]) !== undefined;
        const journal = this.journal;

        let index = journal.indexOf(key);
        let operation: OPERATION;

        if (index !== undefined) {
            // REPLACE branch
            operation = OPERATION.REPLACE;

            const previousValue = this.$items.get(key);
            if (previousValue === value) {
                // if value is the same, avoid re-encoding it.
                return;

            } else if (isRef) {
                // if is schema, force ADD operation if value differ from previous one.
                operation = OPERATION.DELETE_AND_ADD;

                // remove reference from previous value
                if (previousValue !== undefined) {
                    previousValue[$changes].root?.remove(previousValue[$changes]);
                }
            }

            // Re-setting after a delete: discard the snapshot.
            if (journal.snapshotAt(index) !== undefined) {
                journal.forgetSnapshot(index);
            }

        } else {
            // ADD branch
            index = journal.assign(key);
            operation = OPERATION.ADD;
        }

        this.$items.set(key, value);

        changeTree.change(index, operation);

        //
        // set value's parent after the value is set
        // (to avoid encoding "refId" operations before parent's "ADD" operation)
        //
        if (isRef) {
            value[$changes].setParent(this, changeTree.root, index);
        }

        return this;
    }

    get(key: K): V | undefined {
        return this.$items.get(key);
    }

    delete(key: K) {
        if (!this.$items.has(key)) {
            return false;
        }

        const index = this.journal.indexOf(key)!;
        const previousValue = this.$items.get(key)!;

        // Snapshot the deleted value (used by [$filter] for visibility checks
        // until $onEncodeEnd cleans it up).
        this.journal.snapshot(index, previousValue);

        this[$changes].delete(index);

        return this.$items.delete(key);
    }

    clear() {
        const changeTree = this[$changes];

        // discard previous operations.
        changeTree.discard();

        // remove children references
        changeTree.forEachChild((childChangeTree, _) => {
            changeTree.root?.remove(childChangeTree);
        });

        // reset journal (clears all index/key state and snapshots)
        this.journal.reset();

        // clear items
        this.$items.clear();

        changeTree.operation(OPERATION.CLEAR);
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
    pauseTracking(): void { this[$changes].pause(); }
    resumeTracking(): void { this[$changes].resume(); }
    untracked<T>(fn: () => T): T { return this[$changes].untracked(fn); }
    get isTrackingPaused(): boolean { return this[$changes].paused; }

    protected setIndex(index: number, key: K) {
        this.journal.setIndex(index, key);
    }

    protected getIndex(index: number) {
        return this.journal.keyOf(index);
    }

    [$getByIndex](index: number): V | undefined {
        const key = this.journal.keyOf(index);
        return key !== undefined ? this.$items.get(key) : undefined;
    }

    [$deleteByIndex](index: number): void {
        const key = this.journal.keyOf(index);
        if (key !== undefined) {
            this.$items.delete(key);
            this.journal.keyByIndex.delete(index);
        }
    }

    protected [$onEncodeEnd]() {
        this.journal.cleanupAfterEncode();
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

    //
    // Decoding utilities
    //
    // @ts-ignore
    clone(isDecoding?: boolean): MapSchema<V> {
        let cloned: MapSchema<V>;

        if (isDecoding) {
            // client-side
            cloned = Object.assign(new MapSchema(), this);

        } else {
            // server-side
            cloned = new MapSchema();

            this.forEach((value: any, key) => {
                if (value[$changes]) {
                    cloned.set(key, value['clone']());
                } else {
                    cloned.set(key, value);
                }
            })

        }

        return cloned;
    }

}

registerType("map", { constructor: MapSchema });
