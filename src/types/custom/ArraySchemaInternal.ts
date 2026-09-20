import { $changes, $childType, $deleteByIndex, $getByIndex, $items, $proxyTarget, $recorder, $refId, $reset, $resyncPrune, $rev } from "../symbols.js";
import type { Schema } from "../../Schema.js";
import { type IRef, ChangeTree, installUntrackedChangeTree, refTreeOf, defineRefAccessors, refIdOf, stampTree, treeOf } from "../../encoder/ChangeTree.js";
import { ArrayLog } from "../../encoder/ArrayLog.js";
import { CollectionKind } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { assertInstanceType } from "../../encoding/assert.js";

/**
 * EXPERIMENT — ArraySchema with a plain internal array (the 5.x storage
 * model) on the 6.0 op log. Selected at build time with
 * `SCHEMA_ARRAY_IMPL=internal` (see rollup.config.mjs); the default build
 * uses the `Array` subclass in ./ArraySchema.ts.
 *
 * The user-facing object is a Proxy on BOTH sides: reads of `arr[i]` and
 * `arr.length` go through a `get` trap into `items`; writes through `set`.
 * Every builtin delegates to the native on the plain `items` array, so V8's
 * fast paths apply (memmove `shift`, native `forEach` / `for…of`), at the
 * price of a trap on every element read. `Array.isArray(arr)` is false.
 */

const _push = Array.prototype.push;
const $moving: unique symbol = Symbol("$moving");

function indexOfKey(key: string): number {
    const c = key.charCodeAt(0);
    if (c < 48 || c > 57) return -1;
    const n = +key;
    return (n >>> 0 === n && (n !== 0 || key === "0") && String(n) === key) ? n : -1;
}

const ARRAY_PROXY_HANDLER: ProxyHandler<any> = {
    get: (target, key) => {
        if (typeof key === "string") {
            const index = indexOfKey(key);
            if (index !== -1) return target.items[index];
            if (key === "length") return target.items.length;
        }
        return target[key];
    },
    set: (target, key, value) => {
        if (typeof key === "string") {
            const index = indexOfKey(key);
            if (index !== -1) {
                target.$setAt(index, value);
                return true;
            }
            if (key === "length") {
                target.$setLength(value);
                return true;
            }
        }
        target[key] = value;
        return true;
    },
    deleteProperty: (target, key) => {
        if (typeof key === "string") {
            const index = indexOfKey(key);
            if (index !== -1) {
                target.$removeAt(index);
                return true;
            }
        }
        return delete target[key];
    },
    has: (target, key) => {
        if (typeof key === "string") {
            const index = indexOfKey(key);
            if (index !== -1) return index < target.items.length;
        }
        return key in target;
    },
};

function releaseChild(tree: ChangeTree, value: any): void {
    const childTree = refTreeOf(value);
    if (childTree !== undefined) tree.root?.remove(childTree);
}

function attachChild(tree: ChangeTree, parent: any, value: any, index: number): void {
    refTreeOf(value)?.setParent(parent, tree.root, index, tree);
}

function permutationOf(before: any[], after: any[]): number[] | undefined {
    const n = before.length;
    if (after.length !== n) return undefined;
    const perm: number[] = new Array(n);
    let identity = true;
    if (n > 0 && typeof before[0] === "object") {
        const at = new Map<any, number>();
        for (let i = 0; i < n; i++) at.set(before[i], i);
        if (at.size !== n) return undefined;
        for (let k = 0; k < n; k++) {
            const i = at.get(after[k]);
            if (i === undefined) return undefined;
            perm[k] = i;
            if (i !== k) identity = false;
        }
    } else {
        const at = new Map<any, number[]>();
        for (let i = 0; i < n; i++) {
            const list = at.get(before[i]);
            if (list === undefined) at.set(before[i], [i]);
            else list.push(i);
        }
        for (let k = 0; k < n; k++) {
            const list = at.get(after[k]);
            if (list === undefined || list.length === 0) return undefined;
            const i = list.shift()!;
            perm[k] = i;
            if (i !== k) identity = false;
        }
    }
    return identity ? [] : perm;
}

export class ArraySchema<V = any> implements Collection<number, V>, IRef {
    /** Prototype accessor; the tree itself is stamped on the raw target (see ChangeTree.ts). */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;
    [$proxyTarget]: this;
    [$rev]?: number;
    [$moving]?: boolean;
    [$items]: V[];

    protected [$childType]: string | typeof Schema;

    /** The elements. Encoder and decoder index this directly (`tree.elements`, `ref[$items]`). */
    items: V[] = [];

    static [$recorder] = () => new ArrayLog();
    static readonly COLLECTION_KIND = CollectionKind.Array;

    static is(type: any) {
        return Array.isArray(type) || (type['array'] !== undefined);
    }

    static from<T>(iterable: Iterable<T> | ArrayLike<T>, mapfn?: (v: any, k: number) => T, thisArg?: any): ArraySchema<T> {
        const arr = new ArraySchema<T>();
        arr.$pushAll(Array.from(iterable as Iterable<any>, mapfn as any, thisArg));
        return arr;
    }

    static of<T>(...items: T[]): ArraySchema<T> {
        const arr = new ArraySchema<T>();
        arr.$pushAll(items);
        return arr;
    }

    constructor(...items: V[]) {
        this[$proxyTarget] = this;
        this[$items] = this.items;
        this[$childType] = undefined as any;
        this[$moving] = false;

        const proxy = new Proxy(this, ARRAY_PROXY_HANDLER);
        const tree = new ChangeTree(proxy, this);
        stampTree(this, tree); // the raw target only — never the Proxy (see ChangeTree.ts)
        if (items.length > 0) this.$pushAll(items);
        return proxy;
    }

    static initializeForDecoder<V = any>(): ArraySchema<V> {
        const self: any = Object.create(ArraySchema.prototype);
        self.items = [];
        self[$proxyTarget] = self;
        self[$items] = self.items;
        self[$childType] = undefined;
        self[$moving] = false;
        self[$rev] = 0;
        installUntrackedChangeTree(self);
        return new Proxy(self, ARRAY_PROXY_HANDLER);
    }

    pauseTracking(): void { treeOf(this[$proxyTarget]).pause(); }
    resumeTracking(): void { treeOf(this[$proxyTarget]).resume(); }
    untracked<T>(fn: () => T): T { return treeOf(this[$proxyTarget]).untracked(fn); }
    get isTrackingPaused(): boolean { return treeOf(this[$proxyTarget]).paused; }

    get length(): number { return this[$proxyTarget].items.length; }
    set length(n: number) { this[$proxyTarget].$setLength(n); }

    // ────── Mutations (natives on the plain `items` array) ──────

    push(...values: V[]): number {
        return this.$pushAll(values);
    }

    protected $pushAll(values: V[]): number {
        const self = this[$proxyTarget];
        const items = self.items;
        const tree = treeOf(self);
        const childType = self[$childType];
        let n = values.length;
        for (let i = 0; i < n; i++) {
            const value = values[i];
            if (value === undefined || value === null) {
                values = values.slice(0, i);
                n = i;
                break;
            }
            if (childType !== undefined && typeof value === "object") {
                assertInstanceType(value as any, childType as typeof Schema, self as any, i);
            }
        }
        if (n === 0) return items.length;
        const start = items.length;
        if (tree.tracking) {
            (tree.rec as ArrayLog).push(values, start);
            tree.touch();
        }
        if (n < 1024) _push.apply(items, values);
        else for (let i = 0; i < n; i++) items.push(values[i]);
        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < n; i++) attachChild(tree, parent, values[i], start + i);
        }
        return items.length;
    }

    pop(): V | undefined {
        const self = this[$proxyTarget];
        const items = self.items;
        const length = items.length;
        if (length === 0) return undefined;
        const tree = treeOf(self);
        const value = items[length - 1];
        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(length - 1, [value]);
            tree.touch();
        }
        items.pop();
        releaseChild(tree, value);
        return value;
    }

    shift(): V | undefined {
        const self = this[$proxyTarget];
        const items = self.items;
        if (items.length === 0) return undefined;
        const tree = treeOf(self);
        const value = items[0];
        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(0, [value]);
            tree.touch();
        }
        items.shift();
        releaseChild(tree, value);
        return value;
    }

    unshift(...values: V[]): number {
        const self = this[$proxyTarget];
        const items = self.items;
        const n = values.length;
        if (n === 0) return items.length;
        const tree = treeOf(self);
        const childType = self[$childType];
        for (let i = 0; i < n; i++) {
            const value = values[i];
            if (value === undefined || value === null) throw new Error("ArraySchema: elements cannot be null nor undefined.");
            if (childType !== undefined && typeof value === "object") assertInstanceType(value as any, childType as typeof Schema, self as any, i);
        }
        if (tree.tracking) {
            (tree.rec as ArrayLog).insert(0, values);
            tree.touch();
        }
        items.unshift(...values);
        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < n; i++) attachChild(tree, parent, values[i], i);
        }
        return items.length;
    }

    splice(start: number, deleteCount?: number, ...newItems: V[]): V[] {
        const self = this[$proxyTarget];
        const items = self.items;
        const length = items.length;
        start = Math.trunc(start) || 0;
        if (start < 0) start = Math.max(length + start, 0);
        else if (start > length) start = length;
        if (deleteCount === undefined) deleteCount = length - start;
        else deleteCount = Math.min(Math.max(Math.trunc(deleteCount) || 0, 0), length - start);
        const tree = treeOf(self);
        const childType = self[$childType];
        const insertCount = newItems.length;
        for (let i = 0; i < insertCount; i++) {
            const value = newItems[i];
            if (value === undefined || value === null) throw new Error("ArraySchema: elements cannot be null nor undefined.");
            if (childType !== undefined && typeof value === "object") assertInstanceType(value as any, childType as typeof Schema, self as any, i);
        }
        const removed: V[] = items.splice(start, deleteCount, ...newItems);
        if (tree.tracking) {
            const log = tree.rec as ArrayLog;
            if (deleteCount === insertCount) {
                for (let i = 0; i < deleteCount; i++) log.set(start + i, removed[i], newItems[i]);
            } else {
                if (deleteCount > 0) log.remove(start, removed);
                if (insertCount > 0) {
                    if (start === length - deleteCount) log.push(newItems, start);
                    else log.insert(start, newItems);
                }
            }
            if (deleteCount > 0 || insertCount > 0) tree.touch();
        }
        for (let i = 0; i < deleteCount; i++) releaseChild(tree, removed[i]);
        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < insertCount; i++) attachChild(tree, parent, newItems[i], start + i);
        }
        return removed;
    }

    sort(compareFn?: (a: V, b: V) => number): this {
        const self = this[$proxyTarget];
        const items = self.items;
        if (items.length < 2) return this;
        const tree = treeOf(self);
        if (!tree.tracking) {
            items.sort(compareFn);
            return this;
        }
        const before = items.slice();
        items.sort(compareFn);
        const perm = permutationOf(before, items);
        if (perm !== undefined && perm.length > 0) {
            (tree.rec as ArrayLog).reorder(perm);
            tree.touch();
        }
        return this;
    }

    reverse(): this {
        const self = this[$proxyTarget];
        const items = self.items;
        if (items.length < 2) return this;
        const tree = treeOf(self);
        if (tree.tracking) {
            (tree.rec as ArrayLog).reverse();
            tree.touch();
        }
        items.reverse();
        return this;
    }

    fill(value: V, start?: number, end?: number): this {
        const self = this[$proxyTarget];
        const length = self.items.length;
        let from = start === undefined ? 0 : Math.trunc(start);
        let to = end === undefined ? length : Math.trunc(end);
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        for (let i = from; i < to; i++) self.$setAt(i, value);
        return this;
    }

    copyWithin(target: number, start: number, end?: number): this {
        const self = this[$proxyTarget];
        const length = self.items.length;
        let to = Math.trunc(target) || 0;
        let from = Math.trunc(start) || 0;
        let final = end === undefined ? length : (Math.trunc(end) || 0);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (final < 0) final = Math.max(length + final, 0); else final = Math.min(final, length);
        const count = Math.min(final - from, length - to);
        if (count <= 0) return this;
        const segment = self.items.slice(from, from + count);
        for (let i = 0; i < count; i++) self.$setAt(to + i, segment[i]);
        return this;
    }

    set(index: number, value: V): this {
        this[$proxyTarget].$setAt(index, value);
        return this;
    }

    clear(): void {
        const self = this[$proxyTarget];
        const items = self.items;
        if (items.length === 0) return;
        const tree = treeOf(self);
        for (let i = 0, len = items.length; i < len; i++) releaseChild(tree, items[i]);
        if (tree.tracking) {
            (tree.rec as ArrayLog).clear();
            tree.touch();
        }
        items.length = 0;
    }

    move(cb: (arr: this) => void): this {
        const self = this[$proxyTarget];
        const items = self.items;
        const tree = treeOf(self);
        if (!tree.tracking) {
            cb(this);
            return this;
        }
        const before = items.slice();
        self[$moving] = true;
        try { cb(this); } finally { self[$moving] = false; }
        const perm = permutationOf(before, items);
        if (perm === undefined) {
            const after = new Set<any>(items);
            for (let i = 0; i < before.length; i++) if (!after.has(before[i])) releaseChild(tree, before[i]);
            const seen = new Set<any>(before);
            const parent = tree.ref;
            for (let i = 0, len = items.length; i < len; i++) if (!seen.has(items[i])) attachChild(tree, parent, items[i], i);
            (tree.rec as ArrayLog).restate(items.slice());
            tree.touch();
        } else if (perm.length > 0) {
            (tree.rec as ArrayLog).reorder(perm);
            tree.touch();
        }
        return this;
    }

    shuffle(): this {
        return this.move((arr) => {
            const items = arr[$proxyTarget].items;
            let currentIndex = items.length;
            while (currentIndex !== 0) {
                const randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                const tmp = items[currentIndex];
                items[currentIndex] = items[randomIndex];
                items[randomIndex] = tmp;
            }
        });
    }

    // ────── Reads: delegate to the natives on `items` ──────

    forEach(callbackfn: (value: V, index: number, array: V[]) => void, thisArg?: any): void { this[$proxyTarget].items.forEach(callbackfn, thisArg); }
    map<U>(callbackfn: (value: V, index: number, array: V[]) => U, thisArg?: any): U[] { return this[$proxyTarget].items.map(callbackfn, thisArg); }
    filter(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V[] { return this[$proxyTarget].items.filter(predicate, thisArg); }
    find(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): V | undefined { return this[$proxyTarget].items.find(predicate, thisArg); }
    findIndex(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): number { return this[$proxyTarget].items.findIndex(predicate, thisArg); }
    findLast(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V | undefined { return (this[$proxyTarget].items as any).findLast(predicate, thisArg); }
    findLastIndex(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): number { return (this[$proxyTarget].items as any).findLastIndex(predicate, thisArg); }
    some(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean { return this[$proxyTarget].items.some(predicate, thisArg); }
    every(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean { return this[$proxyTarget].items.every(predicate, thisArg); }
    reduce(callbackfn: (previousValue: any, currentValue: V, currentIndex: number, array: V[]) => any, ...initial: any[]): any { const items = this[$proxyTarget].items; return initial.length ? items.reduce(callbackfn, initial[0]) : items.reduce(callbackfn as any); }
    indexOf(searchElement: V, fromIndex?: number): number { return this[$proxyTarget].items.indexOf(searchElement, fromIndex); }
    lastIndexOf(searchElement: V, fromIndex?: number): number { const items = this[$proxyTarget].items; return fromIndex === undefined ? items.lastIndexOf(searchElement) : items.lastIndexOf(searchElement, fromIndex); }
    includes(searchElement: V, fromIndex?: number): boolean { return this[$proxyTarget].items.includes(searchElement, fromIndex); }
    slice(start?: number, end?: number): V[] { return this[$proxyTarget].items.slice(start, end); }
    at(index: number): V | undefined { return this[$proxyTarget].items.at(index); }
    join(separator?: string): string { return this[$proxyTarget].items.join(separator); }
    flat<D extends number = 1>(depth?: D): any[] { return (this[$proxyTarget].items as any).flat(depth); }
    flatMap<U>(callback: (value: V, index: number, array: V[]) => U | ReadonlyArray<U>, thisArg?: any): U[] { return (this[$proxyTarget].items as any).flatMap(callback, thisArg); }
    concat(...args: (V | ConcatArray<V>)[]): V[] { return this[$proxyTarget].items.concat(...args); }
    with(index: number, value: V): V[] { const copy = this[$proxyTarget].items.slice(); if (index < 0) index += copy.length; if (index < 0 || index >= copy.length) throw new RangeError(`Invalid index : ${index}`); copy[index] = value; return copy; }
    toReversed(): V[] { return this[$proxyTarget].items.slice().reverse(); }
    toSorted(compareFn?: (a: V, b: V) => number): V[] { return this[$proxyTarget].items.slice().sort(compareFn); }
    toSpliced(start: number, deleteCount?: number, ...newItems: V[]): V[] { const copy = this[$proxyTarget].items.slice(); if (deleteCount === undefined) copy.splice(start); else copy.splice(start, deleteCount, ...newItems); return copy; }
    [Symbol.iterator](): IterableIterator<V> { return this[$proxyTarget].items[Symbol.iterator](); }
    values(): IterableIterator<V> { return this[$proxyTarget].items.values(); }
    keys(): IterableIterator<number> { return this[$proxyTarget].items.keys(); }
    entries(): IterableIterator<[number, V]> { return this[$proxyTarget].items.entries(); }

    // ────── Proxy trap targets ──────

    protected $setAt(index: number, value: V): void {
        const items = this.items;
        if (this[$moving]) {
            items[index] = value;
            return;
        }
        if (value === undefined || value === null) {
            this.$removeAt(index);
            return;
        }
        const tree = treeOf(this[$proxyTarget]);
        const childType = this[$childType];
        if (childType !== undefined && typeof value === "object") {
            assertInstanceType(value as any, childType as typeof Schema, this as any, index);
        }
        const length = items.length;
        if (index >= length) {
            if (tree.tracking) {
                (tree.rec as ArrayLog).push([value], length);
                tree.touch();
            }
            items.push(value);
            if (typeof childType !== "string") attachChild(tree, tree.ref, value, length);
            return;
        }
        const previousValue = items[index];
        if (previousValue === value) return;
        if (tree.tracking) {
            (tree.rec as ArrayLog).set(index, previousValue, value);
            tree.touch();
        }
        items[index] = value;
        releaseChild(tree, previousValue);
        if (typeof childType !== "string") attachChild(tree, tree.ref, value, index);
    }

    protected $removeAt(index: number): void {
        const items = this.items;
        if (index >= items.length) return;
        const tree = treeOf(this[$proxyTarget]);
        const value = items[index];
        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(index, [value]);
            tree.touch();
        }
        items.splice(index, 1);
        releaseChild(tree, value);
    }

    protected $setLength(newLength: number): void {
        const length = this.items.length;
        if (newLength === 0) this.clear();
        else if (newLength < length) this.splice(newLength, length - newLength);
        else if (newLength > length) console.warn("ArraySchema: can't set .length to a higher value than its length.");
    }

    // ────── Encoder / decoder plumbing ──────

    [$getByIndex](index: number): any { return this[$proxyTarget].items[index]; }
    [$deleteByIndex](index: number): void { this[$proxyTarget].items.splice(index, 1); }

    [$reset]() {
        const self = this[$proxyTarget];
        const items = self.items;
        const tree = treeOf(self);
        for (let i = 0, len = items.length; i < len; i++) (items[i] as any)?.[$reset]?.();
        items.length = 0;
        tree.recycle();
    }

    [$resyncPrune](visited: Set<number | string>, prune: (value: V, identity: number | string) => void, keep: (value: V) => void): void {
        const items = this[$proxyTarget].items;
        const len = items.length;
        let w = 0;
        for (let i = 0; i < len; i++) {
            const value = items[i];
            const refId = refIdOf(value);
            if (visited.has(i) || (refId !== undefined && visited.has(-1 - refId))) {
                keep(value);
                items[w++] = value;
            } else {
                prune(value, i);
            }
        }
        if (w !== len) items.length = w;
    }

    toArray(): V[] { return this[$proxyTarget].items.slice(); }

    toJSON(): any[] {
        const items = this[$proxyTarget].items;
        const length = items.length;
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
            const value: any = items[i];
            out[i] = (typeof value?.toJSON === "function") ? value.toJSON() : value;
        }
        return out;
    }

    clone(): ArraySchema<V> {
        const items = this[$proxyTarget].items;
        const copy: V[] = new Array(items.length);
        for (let i = 0, len = items.length; i < len; i++) {
            const item: any = items[i];
            copy[i] = (refTreeOf(item) !== undefined) ? item.clone() : item;
        }
        const cloned = new ArraySchema<V>();
        cloned.$pushAll(copy);
        return cloned;
    }
}

registerType("array", { constructor: ArraySchema });

defineRefAccessors(ArraySchema.prototype);
