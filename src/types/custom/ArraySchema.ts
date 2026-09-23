import { $changes, $childType, $deleteByIndex, $getByIndex, $proxyTarget, $recorder, $refId, $reset, $resyncPrune, $rev } from "../symbols.js";
import type { Schema } from "../../Schema.js";
import { type IRef, ChangeTree, installUntrackedChangeTree, refTreeOf, defineRefAccessors, refIdOf, stampTree, treeOf } from "../../encoder/ChangeTree.js";
import { ArrayLog } from "../../encoder/ArrayLog.js";
import { CollectionKind } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { assertInstanceType } from "../../encoding/assert.js";
import { arrAppend, arrCopy, arrInsert, arrRemove, arrReverse, arrSplice } from "./arrayOps.js";

/**
 * ArraySchema — a real `Array` subclass with change tracking.
 *
 * Encoder side: `new ArraySchema()` returns a Proxy whose only traps are
 * `set` and `deleteProperty`, so `arr[i] = v`, `arr.length = n` and
 * `delete arr[i]` are recorded; reads go straight to the array. Every method
 * unwraps to the raw target once (`this[$proxyTarget]`) and mutates it by
 * index (see arrayOps.ts) — `super.push()` would re-enter the trap.
 *
 * Decoder side: `initializeForDecoder()` builds a plain Array subclass
 * instance (no Proxy, no recorder); the decoder replays wire ops with the
 * same index helpers.
 *
 * The common builtins (`forEach`, `map`, `filter`, `indexOf`, `slice`, …)
 * are overridden with index loops: V8 runs an `Array.prototype` builtin on
 * a subclass instance through its generic per-property path, far slower
 * than on a plain array. `for…of` / `values` / `keys` / `entries` hand out
 * a small iterator over the raw target (the native array iterator would
 * read every element through the Proxy). What cannot be helped is a read
 * through the Proxy itself — `arr[i]` on the encoder side costs a Proxy
 * [[Get]] even without a `get` trap — so a hot server-side loop
 * over a large array should use `forEach`, `for…of` or `toArray()`.
 *
 * Mutations are recorded on an `ArrayLog` (see encoder/ArrayLog.ts): an
 * ordered op log with the values captured at record time. There is no
 * staged copy of the array and no per-index op merging.
 *
 * `Symbol.species` is `Array`: `map` / `filter` / `slice` / `concat` /
 * `flat` return plain arrays (a species of ArraySchema would make the
 * builtins call `new ArraySchema(n)`).
 */

/** Set while `move()` runs its callback: index writes go straight to the array. */
const $moving: unique symbol = Symbol("$moving");

/** Canonical array index key (`"0"`, `"12"`, never `"01"` / `"1.5"` / `"-1"`). */
function indexOfKey(key: string): number {
    const c = key.charCodeAt(0);
    if (c < 48 || c > 57) return -1; // fast reject: not a digit
    const n = +key;
    return (n >>> 0 === n && (n !== 0 || key === "0") && String(n) === key) ? n : -1;
}

/**
 * Module-level Proxy handler shared by every encoder-side `ArraySchema`.
 * No `get` / `has` traps: reads are forwarded by the engine.
 */
const ARRAY_PROXY_HANDLER: ProxyHandler<any> = {
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
};

/** Live iterators over the raw target — see the class comment. */
class ArrayValues<V> implements IterableIterator<V> {
    private i = 0;
    /**
     * ONE result object per iterator, updated in place (a fresh `{ value, done }`
     * per element roughly doubles the loop; measured: bench/realworld-results.md
     * § Round 2 — C). Every built-in consumer (`for…of`, spread,
     * destructuring, `Array.from`, `yield*`) reads the result before asking for
     * the next one; only code holding a result ACROSS `next()` calls sees it
     * change. `keys()` / `entries()` hand out fresh results.
     */
    private readonly result: { value: V, done: boolean } = { value: undefined as any, done: false };
    constructor(private readonly a: V[]) {}
    next(): IteratorResult<V> {
        const a = this.a;
        const result = this.result;
        if (this.i < a.length) {
            result.value = a[this.i++];
        } else {
            result.value = undefined as any;
            result.done = true;
        }
        return result as IteratorResult<V>;
    }
    [Symbol.iterator](): this { return this; }
}
class ArrayKeys<V> implements IterableIterator<number> {
    private i = 0;
    constructor(private readonly a: V[]) {}
    next(): IteratorResult<number> {
        return (this.i < this.a.length) ? { value: this.i++, done: false } : { value: undefined as any, done: true };
    }
    [Symbol.iterator](): this { return this; }
}
class ArrayEntries<V> implements IterableIterator<[number, V]> {
    private i = 0;
    constructor(private readonly a: V[]) {}
    next(): IteratorResult<[number, V]> {
        const a = this.a;
        if (this.i >= a.length) return { value: undefined as any, done: true };
        const i = this.i++;
        return { value: [i, a[i]], done: false };
    }
    [Symbol.iterator](): this { return this; }
}

/** Release a removed ref child from the encoder root. */
function releaseChild(tree: ChangeTree, value: any): void {
    const childTree = refTreeOf(value);
    if (childTree !== undefined) tree.root?.remove(childTree);
}

/** Attach a ref child; `parent` is the user-facing identity (the Proxy). */
function attachChild(tree: ChangeTree, parent: any, value: any, index: number): void {
    refTreeOf(value)?.setParent(parent, tree.root, index, tree);
}

/**
 * `perm[k]` = old position of the element now at `k`, or `undefined` when
 * `after` is not a permutation of `before` (membership changed). Refs match
 * by identity; primitives by value, first unused occurrence wins.
 */
function permutationOf(before: any[], after: any[]): number[] | undefined {
    const n = before.length;
    if (after.length !== n) return undefined;
    const perm: number[] = new Array(n);
    let identity = true;
    if (n > 0 && typeof before[0] === "object") {
        const at = new Map<any, number>();
        for (let i = 0; i < n; i++) at.set(before[i], i);
        if (at.size !== n) return undefined; // duplicates: not a permutation by identity
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

// ────── Search loops, one per element kind ──────
// A single shared loop sees refs, numbers and strings through the same `===`
// feedback slot and ends up calling the generic StrictEqual stub per element
// (several times slower on numbers and strings); one loop per kind keeps every
// compare monomorphic. The ref loops are unrolled ×8: a pointer compare is
// cheap enough that the loop overhead dominates (measured: bench/realworld-results.md
// § Round 2 — C). Callers normalize `from`
// (0 ≤ from) and `to` (to ≤ length); the arrays never hold holes.

function indexOfRef(arr: ArrayLike<any>, value: object, from: number, len: number): number {
    let i = from;
    for (const end = len - 7; i < end; i += 8) {
        if (arr[i] === value) return i;
        if (arr[i + 1] === value) return i + 1;
        if (arr[i + 2] === value) return i + 2;
        if (arr[i + 3] === value) return i + 3;
        if (arr[i + 4] === value) return i + 4;
        if (arr[i + 5] === value) return i + 5;
        if (arr[i + 6] === value) return i + 6;
        if (arr[i + 7] === value) return i + 7;
    }
    for (; i < len; i++) if (arr[i] === value) return i;
    return -1;
}
function indexOfNumber(arr: ArrayLike<any>, value: number, from: number, len: number): number {
    for (let i = from; i < len; i++) if (arr[i] === value) return i;
    return -1;
}
function indexOfString(arr: ArrayLike<any>, value: string, from: number, len: number): number {
    for (let i = from; i < len; i++) if (arr[i] === value) return i;
    return -1;
}
function indexOfOther(arr: ArrayLike<any>, value: any, from: number, len: number): number {
    for (let i = from; i < len; i++) if (arr[i] === value) return i;
    return -1;
}
/** `Array#indexOf` semantics on `arr[from, len)`; dispatches on the kind of `value`. */
function indexOfKind(arr: ArrayLike<any>, value: any, from: number, len: number): number {
    switch (typeof value) {
        case "object": return indexOfRef(arr, value, from, len);
        case "number": return indexOfNumber(arr, value, from, len);
        case "string": return indexOfString(arr, value, from, len);
        default: return indexOfOther(arr, value, from, len);
    }
}

function lastIndexOfRef(arr: ArrayLike<any>, value: object, from: number): number {
    let i = from;
    for (; i >= 7; i -= 8) {
        if (arr[i] === value) return i;
        if (arr[i - 1] === value) return i - 1;
        if (arr[i - 2] === value) return i - 2;
        if (arr[i - 3] === value) return i - 3;
        if (arr[i - 4] === value) return i - 4;
        if (arr[i - 5] === value) return i - 5;
        if (arr[i - 6] === value) return i - 6;
        if (arr[i - 7] === value) return i - 7;
    }
    for (; i >= 0; i--) if (arr[i] === value) return i;
    return -1;
}
function lastIndexOfNumber(arr: ArrayLike<any>, value: number, from: number): number {
    for (let i = from; i >= 0; i--) if (arr[i] === value) return i;
    return -1;
}
function lastIndexOfString(arr: ArrayLike<any>, value: string, from: number): number {
    for (let i = from; i >= 0; i--) if (arr[i] === value) return i;
    return -1;
}
function lastIndexOfOther(arr: ArrayLike<any>, value: any, from: number): number {
    for (let i = from; i >= 0; i--) if (arr[i] === value) return i;
    return -1;
}
/** `Array#lastIndexOf` semantics on `arr[0, from]` (from ≤ length − 1). */
function lastIndexOfKind(arr: ArrayLike<any>, value: any, from: number): number {
    switch (typeof value) {
        case "object": return lastIndexOfRef(arr, value, from);
        case "number": return lastIndexOfNumber(arr, value, from);
        case "string": return lastIndexOfString(arr, value, from);
        default: return lastIndexOfOther(arr, value, from);
    }
}

/** `ToIntegerOrInfinity` with −0 folded to 0 (a −0 index would take the slow keyed path). */
function toIntegerIndex(n: any): number {
    return Math.trunc(n) || 0;
}

/** Spec `fromIndex` for indexOf / includes: the first index to look at, or −1 when past the end. */
function forwardFrom(fromIndex: any, length: number): number {
    let from = toIntegerIndex(fromIndex);
    if (from >= length) return -1;
    if (from < 0) {
        from += length;
        if (from < 0) from = 0;
    }
    return from;
}

export class ArraySchema<V = any> extends Array<V> implements Collection<number, V>, IRef {
    /** Prototype accessor; the tree itself is stamped on the raw target (see ChangeTree.ts). */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;
    [$proxyTarget]: this;
    [$rev]?: number;
    [$moving]?: boolean;

    protected [$childType]: string | typeof Schema;

    static [$recorder] = () => new ArrayLog();
    static readonly COLLECTION_KIND = CollectionKind.Array;

    /** Derived arrays (`map`, `filter`, `slice`, `concat`, `flat`) are plain arrays. */
    static get [Symbol.species](): ArrayConstructor {
        return Array;
    }

    static is(type: any) {
        return (
            // type format: ["string"]
            Array.isArray(type) ||

            // type format: { array: "string" }
            (type['array'] !== undefined)
        );
    }

    /** Tracked equivalent of `Array.from` (the native one bypasses the Proxy `set` trap). */
    static from<T>(iterable: Iterable<T> | ArrayLike<T>, mapfn?: (v: any, k: number) => T, thisArg?: any): ArraySchema<T> {
        const arr = new ArraySchema<T>();
        arr.$pushAll(Array.from(iterable as Iterable<any>, mapfn as any, thisArg));
        return arr;
    }

    /** Tracked equivalent of `Array.of`. */
    static of<T>(...items: T[]): ArraySchema<T> {
        const arr = new ArraySchema<T>();
        arr.$pushAll(items);
        return arr;
    }

    /**
     * Never `super(...items)`: a single number argument would allocate holes.
     * Returns the Proxy — the public identity of the array.
     */
    constructor(...items: V[]) {
        super();
        this[$proxyTarget] = this;
        this[$childType] = undefined as any;
        this[$moving] = false;

        const proxy = new Proxy(this, ARRAY_PROXY_HANDLER);

        const tree = new ChangeTree(proxy, this);
        stampTree(this, tree); // the raw target only — never the Proxy (see ChangeTree.ts)

        if (items.length > 0) this.$pushAll(items);

        return proxy;
    }

    /**
     * Decoder-side factory: an exotic Array with `ArraySchema.prototype`
     * whose constructor body never runs (no Proxy, no ChangeTree).
     */
    static initializeForDecoder<V = any>(): ArraySchema<V> {
        const self: any = Reflect.construct(Array, [], ArraySchema);
        self[$proxyTarget] = self;
        self[$childType] = undefined;
        self[$moving] = false;
        self[$rev] = 0;
        installUntrackedChangeTree(self);
        return self;
    }

    // ────── Change tracking control (same API as Schema) ──────
    pauseTracking(): void { treeOf(this[$proxyTarget]).pause(); }
    resumeTracking(): void { treeOf(this[$proxyTarget]).resume(); }
    untracked<T>(fn: () => T): T { return treeOf(this[$proxyTarget]).untracked(fn); }
    get isTrackingPaused(): boolean { return treeOf(this[$proxyTarget]).paused; }

    // ────── Mutations ──────

    push(...values: V[]): number {
        return this.$pushAll(values);
    }

    /** `push` without spreading (large `from()` / constructor inputs). */
    protected $pushAll(values: V[]): number {
        const self = this[$proxyTarget];
        const tree = treeOf(self);
        const childType = self[$childType];
        let n = values.length;

        for (let i = 0; i < n; i++) {
            const value = values[i];
            if (value === undefined || value === null) {
                // `null` / `undefined` elements are not representable on the
                // wire: stop at the first one (matches the historical behaviour)
                values = values.slice(0, i);
                n = i;
                break;
            }
            if (childType !== undefined && typeof value === "object") {
                assertInstanceType(value as any, childType as typeof Schema, self, i);
            }
        }
        if (n === 0) return self.length;

        const start = self.length;
        if (tree.tracking) {
            (tree.rec as ArrayLog).push(values, start);
            tree.touch();
        }

        arrAppend(self, values);

        // set the parent AFTER recording (the parent's op precedes the child's chunk)
        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < n; i++) attachChild(tree, parent, values[i], start + i);
        }

        return self.length;
    }

    pop(): V | undefined {
        const self = this[$proxyTarget];
        const length = self.length;
        if (length === 0) return undefined;

        const tree = treeOf(self);
        const value = self[length - 1];

        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(length - 1, [value]);
            tree.touch();
        }

        self.length = length - 1;
        releaseChild(tree, value);
        return value;
    }

    shift(): V | undefined {
        const self = this[$proxyTarget];
        if (self.length === 0) return undefined;

        const tree = treeOf(self);
        const value = self[0];

        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(0, [value]);
            tree.touch();
        }

        arrRemove(self, 0, 1);
        releaseChild(tree, value);
        return value;
    }

    unshift(...values: V[]): number {
        const self = this[$proxyTarget];
        const n = values.length;
        if (n === 0) return self.length;

        const tree = treeOf(self);
        const childType = self[$childType];
        for (let i = 0; i < n; i++) {
            const value = values[i];
            if (value === undefined || value === null) {
                throw new Error("ArraySchema: elements cannot be null nor undefined.");
            }
            if (childType !== undefined && typeof value === "object") {
                assertInstanceType(value as any, childType as typeof Schema, self, i);
            }
        }

        if (tree.tracking) {
            (tree.rec as ArrayLog).insert(0, values);
            tree.touch();
        }

        arrInsert(self, 0, values);

        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < n; i++) attachChild(tree, parent, values[i], i);
        }

        return self.length;
    }

    splice(start: number, deleteCount?: number, ...items: V[]): V[] {
        const self = this[$proxyTarget];
        const length = self.length;

        // normalize per the spec
        start = Math.trunc(start) || 0;
        if (start < 0) start = Math.max(length + start, 0);
        else if (start > length) start = length;
        if (deleteCount === undefined) deleteCount = length - start;
        else deleteCount = Math.min(Math.max(Math.trunc(deleteCount) || 0, 0), length - start);

        const tree = treeOf(self);
        const childType = self[$childType];
        const insertCount = items.length;

        for (let i = 0; i < insertCount; i++) {
            const value = items[i];
            if (value === undefined || value === null) {
                throw new Error("ArraySchema: elements cannot be null nor undefined.");
            }
            if (childType !== undefined && typeof value === "object") {
                assertInstanceType(value as any, childType as typeof Schema, self, i);
            }
        }

        const removed = arrSplice(self, start, deleteCount, items);

        if (tree.tracking) {
            const log = tree.rec as ArrayLog;
            if (deleteCount === insertCount) {
                // one-for-one replacement: SET per slot (a ref child reports
                // onRemove + onAdd + one onChange, as a direct index write)
                for (let i = 0; i < deleteCount; i++) log.set(start + i, removed[i], items[i]);
            } else {
                if (deleteCount > 0) log.remove(start, removed);
                if (insertCount > 0) {
                    if (start === length - deleteCount) log.push(items, start); // insert at the tail = append
                    else log.insert(start, items);
                }
            }
            if (deleteCount > 0 || insertCount > 0) tree.touch();
        }

        for (let i = 0; i < deleteCount; i++) releaseChild(tree, removed[i]);
        if (typeof childType !== "string") {
            const parent = tree.ref;
            for (let i = 0; i < insertCount; i++) attachChild(tree, parent, items[i], start + i);
        }

        return removed;
    }

    /**
     * Sorts in place and records one REORDER op (the permutation) instead of
     * a REPLACE per index. Nothing is recorded when the order is unchanged.
     */
    sort(compareFn?: (a: V, b: V) => number): this {
        const self = this[$proxyTarget];
        const length = self.length;
        if (length < 2) return this;
        // sort a plain copy and write it back (the native sort is generic on a subclass receiver)
        const before = arrCopy(self);
        const sorted = before.slice().sort(compareFn);
        for (let i = 0; i < length; i++) self[i] = sorted[i];
        const tree = treeOf(self);
        if (tree.tracking) {
            const perm = permutationOf(before, sorted);
            if (perm !== undefined && perm.length > 0) {
                (tree.rec as ArrayLog).reorder(perm);
                tree.touch();
            }
        }
        return this;
    }

    reverse(): this {
        const self = this[$proxyTarget];
        if (self.length < 2) return this;
        const tree = treeOf(self);
        if (tree.tracking) {
            (tree.rec as ArrayLog).reverse();
            tree.touch();
        }
        arrReverse(self);
        return this;
    }

    fill(value: V, start?: number, end?: number): this {
        const self = this[$proxyTarget];
        const length = self.length;
        let from = start === undefined ? 0 : Math.trunc(start);
        let to = end === undefined ? length : Math.trunc(end);
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        for (let i = from; i < to; i++) self.$setAt(i, value);
        return this;
    }

    copyWithin(target: number, start: number, end?: number): this {
        const self = this[$proxyTarget];
        const length = self.length;
        let to = Math.trunc(target) || 0;
        let from = Math.trunc(start) || 0;
        let final = end === undefined ? length : (Math.trunc(end) || 0);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (final < 0) final = Math.max(length + final, 0); else final = Math.min(final, length);
        const count = Math.min(final - from, length - to);
        if (count <= 0) return this;
        const segment = arrCopy(self, from, from + count);
        for (let i = 0; i < count; i++) self.$setAt(to + i, segment[i]);
        return this;
    }

    /** Tracked `arr[index] = value` for code paths that cannot go through the Proxy. */
    set(index: number, value: V): this {
        this[$proxyTarget].$setAt(index, value);
        return this;
    }

    clear(): void {
        const self = this[$proxyTarget];
        if (self.length === 0) return;

        const tree = treeOf(self);
        for (let i = 0, len = self.length; i < len; i++) releaseChild(tree, self[i]);

        if (tree.tracking) {
            (tree.rec as ArrayLog).clear();
            tree.touch();
        }

        self.length = 0; // raw target: no trap
    }

    /**
     * Reorder elements in place. The callback may swap elements freely
     * (`[arr[0], arr[1]] = [arr[1], arr[0]]`); one REORDER op is recorded
     * for the whole permutation. A callback that changes the membership
     * falls back to a full re-statement of the array.
     *
     * Example:
     *     state.cards.move((cards) => {
     *         [cards[4], cards[3]] = [cards[3], cards[4]];
     *         [cards[3], cards[2]] = [cards[2], cards[3]];
     *     })
     */
    move(cb: (arr: this) => void): this {
        const self = this[$proxyTarget];
        const tree = treeOf(self);
        if (!tree.tracking) {
            cb(this);
            return this;
        }
        const before = arrCopy(self);
        self[$moving] = true;
        try { cb(this); } finally { self[$moving] = false; }

        const perm = permutationOf(before, self);
        if (perm === undefined) {
            // membership changed: release / attach the difference, re-state
            const after = new Set<any>(self);
            for (let i = 0; i < before.length; i++) {
                if (!after.has(before[i])) releaseChild(tree, before[i]);
            }
            const seen = new Set<any>(before);
            const parent = tree.ref;
            for (let i = 0, len = self.length; i < len; i++) {
                if (!seen.has(self[i])) attachChild(tree, parent, self[i], i);
            }
            (tree.rec as ArrayLog).restate(arrCopy(self));
            tree.touch();
        } else if (perm.length > 0) {
            (tree.rec as ArrayLog).reorder(perm);
            tree.touch();
        }
        return this;
    }

    shuffle(): this {
        return this.move((arr) => {
            const self = arr[$proxyTarget];
            let currentIndex = self.length;
            while (currentIndex !== 0) {
                const randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                const tmp = self[currentIndex];
                self[currentIndex] = self[randomIndex];
                self[randomIndex] = tmp;
            }
        });
    }

    // ────── ES2023 non-mutating helpers (typed here: the build targets lib ES2022) ──────

    /** Copy with `index` replaced (negative counts from the end). Plain array. */
    with(index: number, value: V): V[] {
        const self = this[$proxyTarget];
        const copy = arrCopy(self);
        if (index < 0) index += copy.length;
        if (index < 0 || index >= copy.length) throw new RangeError(`Invalid index : ${index}`);
        copy[index] = value;
        return copy;
    }

    toReversed(): V[] {
        return arrCopy(this[$proxyTarget]).reverse();
    }

    toSorted(compareFn?: (a: V, b: V) => number): V[] {
        return arrCopy(this[$proxyTarget]).sort(compareFn);
    }

    toSpliced(start: number, deleteCount?: number, ...items: V[]): V[] {
        const copy: V[] = arrCopy(this[$proxyTarget]);
        if (deleteCount === undefined) copy.splice(start);
        else copy.splice(start, deleteCount, ...items);
        return copy;
    }

    findLast<S extends V>(predicate: (value: V, index: number, array: V[]) => value is S, thisArg?: any): S | undefined;
    findLast(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V | undefined;
    findLast(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V | undefined {
        const self = this[$proxyTarget];
        for (let i = self.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, self[i], i, this)) return self[i];
        }
        return undefined;
    }

    findLastIndex(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): number {
        const self = this[$proxyTarget];
        for (let i = self.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, self[i], i, this)) return i;
        }
        return -1;
    }

    // ────── Read-side builtins as index loops (see the class comment) ──────
    // Callbacks receive the public identity (`this`, the Proxy on the encoder
    // side) so writes made through the `array` argument are tracked.

    // Without a `thisArg` the callback is called directly (`Function#call`
    // costs a builtin call per element until TurboFan inlines it, and on
    // polymorphic callers). A direct call passes `this = undefined` exactly
    // like `.call(undefined, …)`, so the two branches are equivalent.

    forEach(callbackfn: (value: V, index: number, array: V[]) => void, thisArg?: any): void {
        const self = this[$proxyTarget];
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) callbackfn(self[i], i, this);
        } else {
            for (let i = 0; i < len; i++) callbackfn.call(thisArg, self[i], i, this);
        }
    }

    map<U>(callbackfn: (value: V, index: number, array: V[]) => U, thisArg?: any): U[] {
        const self = this[$proxyTarget];
        const len = self.length;
        const out: U[] = new Array(len);
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) out[i] = callbackfn(self[i], i, this);
        } else {
            for (let i = 0; i < len; i++) out[i] = callbackfn.call(thisArg, self[i], i, this);
        }
        return out;
    }

    filter<S extends V>(predicate: (value: V, index: number, array: V[]) => value is S, thisArg?: any): S[];
    filter(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V[];
    filter(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V[] {
        const self = this[$proxyTarget];
        const len = self.length;
        const out: V[] = [];
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) {
                const value = self[i];
                if (predicate(value, i, this)) out.push(value);
            }
        } else {
            for (let i = 0; i < len; i++) {
                const value = self[i];
                if (predicate.call(thisArg, value, i, this)) out.push(value);
            }
        }
        return out;
    }

    find<S extends V>(predicate: (value: V, index: number, obj: V[]) => value is S, thisArg?: any): S | undefined;
    find(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): V | undefined;
    find(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): V | undefined {
        // (returns the value captured before the predicate ran, as the spec does)
        const self = this[$proxyTarget];
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) { const value = self[i]; if (predicate(value, i, this)) return value; }
        } else {
            for (let i = 0; i < len; i++) { const value = self[i]; if (predicate.call(thisArg, value, i, this)) return value; }
        }
        return undefined;
    }

    findIndex(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): number {
        const self = this[$proxyTarget];
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) if (predicate(self[i], i, this)) return i;
        } else {
            for (let i = 0; i < len; i++) if (predicate.call(thisArg, self[i], i, this)) return i;
        }
        return -1;
    }

    some(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean {
        return this.findIndex(predicate, thisArg) !== -1;
    }

    every<S extends V>(predicate: (value: V, index: number, array: V[]) => value is S, thisArg?: any): this is S[];
    every(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean;
    every(predicate: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean {
        const self = this[$proxyTarget];
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) if (!predicate(self[i], i, this)) return false;
        } else {
            for (let i = 0; i < len; i++) if (!predicate.call(thisArg, self[i], i, this)) return false;
        }
        return true;
    }

    reduce(callbackfn: (previousValue: V, currentValue: V, currentIndex: number, array: V[]) => V): V;
    reduce(callbackfn: (previousValue: V, currentValue: V, currentIndex: number, array: V[]) => V, initialValue: V): V;
    reduce<U>(callbackfn: (previousValue: U, currentValue: V, currentIndex: number, array: V[]) => U, initialValue: U): U;
    reduce(callbackfn: (previousValue: any, currentValue: V, currentIndex: number, array: V[]) => any, initialValue?: any): any {
        const self = this[$proxyTarget];
        const len = self.length;
        let i = 0;
        let acc: any;
        if (arguments.length < 2) {
            if (len === 0) throw new TypeError("Reduce of empty array with no initial value");
            acc = self[0];
            i = 1;
        } else {
            acc = initialValue;
        }
        for (; i < len; i++) acc = callbackfn(acc, self[i], i, this);
        return acc;
    }

    // `indexOf` / `lastIndexOf` / `includes` are JS loops on purpose: the
    // native builtins reject a subclass receiver (`Cast<FastJSArray>` needs
    // the initial Array.prototype) and fall back to a much slower runtime path.

    indexOf(searchElement: V, fromIndex?: number): number {
        const self = this[$proxyTarget];
        const length = self.length;
        const from = forwardFrom(fromIndex, length);
        if (from === -1) return -1;
        return indexOfKind(self, searchElement, from, length);
    }

    lastIndexOf(searchElement: V, fromIndex?: number): number {
        const self = this[$proxyTarget];
        const length = self.length;
        if (length === 0) return -1;
        // spec: an explicitly passed `undefined` is ToIntegerOrInfinity(undefined) = 0
        let from = (arguments.length < 2) ? length - 1 : toIntegerIndex(fromIndex);
        if (from < 0) {
            from += length;
            if (from < 0) return -1;
        } else if (from >= length) {
            from = length - 1;
        }
        return lastIndexOfKind(self, searchElement, from);
    }

    includes(searchElement: V, fromIndex?: number): boolean {
        const self = this[$proxyTarget];
        const length = self.length;
        const from = forwardFrom(fromIndex, length);
        if (from === -1) return false;
        if (searchElement !== searchElement) { // NaN: SameValueZero
            for (let i = from; i < length; i++) {
                const v = self[i];
                if (v !== v) return true;
            }
            return false;
        }
        return indexOfKind(self, searchElement, from, length) !== -1;
    }

    /** Plain-array copy of a range (negative indexes count from the end). */
    slice(start?: number, end?: number): V[] {
        const self = this[$proxyTarget];
        const length = self.length;
        let from = (start === undefined) ? 0 : Math.trunc(start) || 0;
        let to = (end === undefined) ? length : Math.trunc(end) || 0;
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        return arrCopy(self, from, to);
    }

    at(index: number): V | undefined {
        const self = this[$proxyTarget];
        index = Math.trunc(index) || 0;
        if (index < 0) index += self.length;
        return self[index];
    }

    [Symbol.iterator](): ReturnType<Array<V>[typeof Symbol.iterator]> {
        return new ArrayValues(this[$proxyTarget]) as any;
    }

    values(): ReturnType<Array<V>["values"]> {
        return new ArrayValues(this[$proxyTarget]) as any;
    }

    keys(): ReturnType<Array<V>["keys"]> {
        return new ArrayKeys(this[$proxyTarget]) as any;
    }

    entries(): ReturnType<Array<V>["entries"]> {
        return new ArrayEntries(this[$proxyTarget]) as any;
    }

    // ────── Proxy trap targets (always called on the raw target) ──────

    protected $setAt(index: number, value: V): void {
        if (this[$moving]) {
            this[index] = value;
            return;
        }
        if (value === undefined || value === null) {
            this.$removeAt(index);
            return;
        }

        const tree = treeOf(this[$proxyTarget]);
        const childType = this[$childType];
        if (childType !== undefined && typeof value === "object") {
            assertInstanceType(value as any, childType as typeof Schema, this, index);
        }

        const length = this.length;
        if (index >= length) {
            // a write past the end appends: the array never holds holes
            if (tree.tracking) {
                (tree.rec as ArrayLog).push([value], length);
                tree.touch();
            }
            this[length] = value;
            if (typeof childType !== "string") attachChild(tree, tree.ref, value, length);
            return;
        }

        const previousValue = this[index];
        if (previousValue === value) return;

        if (tree.tracking) {
            (tree.rec as ArrayLog).set(index, previousValue, value);
            tree.touch();
        }
        this[index] = value;
        releaseChild(tree, previousValue);
        if (typeof childType !== "string") attachChild(tree, tree.ref, value, index);
    }

    protected $removeAt(index: number): void {
        if (index >= this.length) return;
        const tree = treeOf(this[$proxyTarget]);
        const value = this[index];
        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(index, [value]);
            tree.touch();
        }
        arrRemove(this, index, 1);
        releaseChild(tree, value);
    }

    protected $setLength(newLength: number): void {
        const length = this.length;
        if (newLength === 0) {
            this.clear();
        } else if (newLength < length) {
            this.splice(newLength, length - newLength);
        } else if (newLength > length) {
            console.warn("ArraySchema: can't set .length to a higher value than its length.");
        }
    }

    // ────── Encoder / decoder plumbing ──────

    [$getByIndex](index: number): any {
        return this[index];
    }

    [$deleteByIndex](index: number): void {
        arrRemove(this[$proxyTarget], index, 1);
    }

    /**
     * Pool reset: empty this array and recycle its ChangeTree WITHOUT recording
     * any wire op (the parent field's ADD/DELETE owns the wire). Recurses into
     * ref-type children. Called by Schema.reset when a pooled entity has an
     * array field. The instance must already be detached from the encoder.
     */
    [$reset]() {
        const self = this[$proxyTarget];
        const tree = treeOf(self);
        for (let i = 0, len = self.length; i < len; i++) (self[i] as any)?.[$reset]?.();
        self.length = 0;
        tree.recycle();
    }

    /**
     * Resync sweep (decoder): a positional snapshot is authoritative and has
     * already truncated the array, so every element is visited by index; an
     * identity snapshot (filtered arrays) reports `-1 - refId` per element
     * and anything else is pruned.
     */
    [$resyncPrune](
        visited: Set<number | string>,
        prune: (value: V, identity: number | string) => void,
        keep: (value: V) => void,
    ): void {
        const self = this[$proxyTarget];
        const len = self.length;
        let w = 0; // survivors compact in place
        for (let i = 0; i < len; i++) {
            const value = self[i];
            const refId = refIdOf(value);
            if (visited.has(i) || (refId !== undefined && visited.has(-1 - refId))) {
                keep(value);
                self[w++] = value;
            } else {
                prune(value, i);
            }
        }
        if (w !== len) self.length = w;
    }

    toArray(): V[] {
        return arrCopy(this[$proxyTarget]);
    }

    toJSON(): any[] {
        const self = this[$proxyTarget];
        const length = self.length;
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
            const value: any = self[i];
            out[i] = (typeof value?.toJSON === "function") ? value.toJSON() : value;
        }
        return out;
    }

    clone(): ArraySchema<V> {
        const self = this[$proxyTarget];
        const items: V[] = new Array(self.length);
        for (let i = 0, len = self.length; i < len; i++) {
            const item: any = self[i];
            items[i] = (refTreeOf(item) !== undefined) ? item.clone() : item;
        }
        const cloned = new ArraySchema<V>();
        cloned.$pushAll(items);
        return cloned;
    }
}

registerType("array", { constructor: ArraySchema });

defineRefAccessors(ArraySchema.prototype);
