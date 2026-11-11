import { $changes, $childType, $deleteByIndex, $elements, $getByIndex, $refId, $reset } from "../symbols.js";
import type { Schema } from "../../Schema.js";
import { type IRef, type ChangeTree, createTree, refTreeOf, defineRefAccessors, stampTree, treeOf } from "../../encoder/ChangeTree.js";
import type { ArrayLog } from "../../encoder/ArrayLog.js";
import { CollectionKind } from "../../encoding/spec.js";
import { shadowMetadata } from "../../symbol.shim.js";
import { assertInstanceType } from "../../encoding/assert.js";

/** Dead slots tolerated at the front before `shift()` compacts. */
const COMPACT_MIN = 32;

/**
 * QueueSchema — a first-in, first-out array for the encoder side.
 *
 * It goes in an array field (`@type([Item])`, `t.queue(Item)`) and travels as
 * one: `push` and `shift` are the array's PUSH and REMOVE ops, so clients
 * (every SDK) decode a regular `ArraySchema` and need no queue type.
 *
 * What differs is the storage. `ArraySchema#shift()` slides every element
 * down one slot — microseconds per call on thousands of Schema children.
 * A queue only advances a head offset and drops the dead front in one native
 * move once it is half the storage, so `shift()` is O(1) amortized. The price
 * is the API: no index syntax (`at(i)` instead), no insertion or removal in
 * the middle.
 */
export class QueueSchema<V = any> implements IRef {
    /** Prototype accessor; the tree itself is stamped on the instance (see ChangeTree.ts). */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;

    protected [$childType]: string | typeof Schema;

    /** Live elements are `items[head …]`. */
    protected items: V[] = [];
    protected head = 0;

    static readonly COLLECTION_KIND = CollectionKind.Array;

    constructor(...values: V[]) {
        this[$childType] = undefined as any;
        stampTree(this, createTree(this));
        if (values.length > 0) this.push(...values);
    }

    get length(): number {
        return this.items.length - this.head;
    }

    // ────── Change tracking control (same API as Schema) ──────
    pauseTracking(): void { treeOf(this).pause(); }
    resumeTracking(): void { treeOf(this).resume(); }
    untracked<T>(fn: () => T): T { return treeOf(this).untracked(fn); }
    get isTrackingPaused(): boolean { return treeOf(this).paused; }

    // ────── Mutations ──────

    push(...values: V[]): number {
        const n = values.length;
        const items = this.items;
        if (n === 0) return items.length - this.head;

        const tree = treeOf(this);
        const childType = this[$childType];
        for (let i = 0; i < n; i++) {
            const value = values[i];
            if (value === undefined || value === null) {
                throw new Error("QueueSchema: elements cannot be null nor undefined.");
            }
            if (childType !== undefined && typeof value === "object") {
                assertInstanceType(value as any, childType as typeof Schema, this as any, i);
            }
        }

        const start = items.length - this.head;
        if (tree.tracking) {
            (tree.rec as ArrayLog).push(values, start);
            tree.touch();
        }
        for (let i = 0; i < n; i++) items.push(values[i]);

        // set the parent AFTER recording (the parent's op precedes the child's chunk)
        if (typeof childType !== "string") {
            const root = tree.root;
            for (let i = 0; i < n; i++) refTreeOf(values[i])?.setParent(this as any, root, start + i, tree);
        }
        return items.length - this.head;
    }

    /** Remove and return the oldest element. */
    shift(): V | undefined {
        const items = this.items;
        const head = this.head;
        if (head === items.length) return undefined;

        const tree = treeOf(this);
        const value = items[head];
        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(0, [value]);
            tree.touch();
        }

        items[head] = undefined as any; // no stale reference in the dead front
        const dead = head + 1;
        if (dead === items.length) {
            items.length = 0;
            this.head = 0;
        } else if (dead >= COMPACT_MIN && dead * 2 >= items.length) {
            items.splice(0, dead);
            this.head = 0;
        } else {
            this.head = dead;
        }

        const childTree = refTreeOf(value);
        if (childTree !== undefined) tree.root?.remove(childTree);
        return value;
    }

    clear(): void {
        const items = this.items;
        const head = this.head;
        if (head === items.length) return;

        const tree = treeOf(this);
        const root = tree.root;
        if (root !== undefined) {
            for (let i = head, len = items.length; i < len; i++) {
                const childTree = refTreeOf(items[i]);
                if (childTree !== undefined) root.remove(childTree);
            }
        }
        if (tree.tracking) {
            (tree.rec as ArrayLog).clear();
            tree.touch();
        }
        items.length = 0;
        this.head = 0;
    }

    // ────── Reads ──────

    /** Element `index` places from the front (negative counts from the back). */
    at(index: number): V | undefined {
        const items = this.items;
        const head = this.head;
        index = Math.trunc(index) || 0;
        if (index < 0) index += items.length - head;
        return (index < 0) ? undefined : items[head + index];
    }

    /** The oldest element — what `shift()` would return. */
    peek(): V | undefined {
        return this.items[this.head];
    }

    forEach(callbackfn: (value: V, index: number, queue: this) => void): void {
        const items = this.items;
        for (let i = this.head, k = 0; i < items.length; i++, k++) callbackfn(items[i], k, this);
    }

    *[Symbol.iterator](): IterableIterator<V> {
        const items = this.items;
        for (let i = this.head; i < items.length; i++) yield items[i];
    }

    values(): IterableIterator<V> {
        return this[Symbol.iterator]();
    }

    toArray(): V[] {
        return this.items.slice(this.head);
    }

    toJSON(): (V extends { toJSON(...args: any[]): infer R } ? R : V)[] {
        const items = this.items;
        const out: any[] = [];
        for (let i = this.head; i < items.length; i++) {
            const value: any = items[i];
            out.push((typeof value?.toJSON === "function") ? value.toJSON() : value);
        }
        return out;
    }

    clone(): QueueSchema<V> {
        const cloned = new QueueSchema<V>();
        const items = this.items;
        for (let i = this.head; i < items.length; i++) {
            const item: any = items[i];
            cloned.push((refTreeOf(item) !== undefined) ? item.clone() : item);
        }
        return cloned;
    }

    // ────── Encoder plumbing ──────

    /** The live elements as a plain array from index 0 (drops the dead front). */
    get [$elements](): V[] {
        const head = this.head;
        if (head !== 0) {
            this.items.splice(0, head);
            this.head = 0;
        }
        return this.items;
    }

    [$getByIndex](index: number): any {
        return this.items[this.head + index];
    }

    [$deleteByIndex](index: number): void {
        this.items.splice(this.head + index, 1);
    }

    /** Pool reset — see `ArraySchema[$reset]`. */
    [$reset]() {
        const items = this.items;
        for (let i = this.head; i < items.length; i++) (items[i] as any)?.[$reset]?.();
        items.length = 0;
        this.head = 0;
        treeOf(this).recycle();
    }
}

shadowMetadata(QueueSchema);
defineRefAccessors(QueueSchema.prototype);
