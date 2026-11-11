import { $changes, $childType, $deleteByIndex, $elements, $getByIndex, $recorder, $refId, $reset, $resyncPrune, $rev } from "../symbols.js";
import type { Schema } from "../../Schema.js";
import { type IRef, type ChangeTree, createTree, installUntrackedChangeTree, refTreeOf, defineRefAccessors, refIdOf, stampTree, treeOf } from "../../encoder/ChangeTree.js";
import type { ArrayLog } from "../../encoder/ArrayLog.js";
import { CollectionKind } from "../../encoding/spec.js";
import { registerType } from "../registry.js";
import { Collection } from "../HelperTypes.js";
import { assertInstanceType } from "../../encoding/assert.js";
import { arrAppend, arrCopy, arrInsert, arrRemove, arrReverse, arrSplice } from "./arrayOps.js";

/**
 * ArraySchema — a real `Array` subclass with change tracking.
 *
 * There is no Proxy: the instance is the array, so `arr[i]` reads cost what
 * they cost on a plain array. Only the methods record — `arr[i] = v`,
 * `arr.length = n` and `delete arr[i]` change the local array without
 * telling the encoder (the index signature and `length` are typed read-only
 * for that reason). Write with `set(i, v)`, truncate with `splice` / `clear`.
 *
 * Decoder side: `initializeForDecoder()` builds an instance with no
 * recorder; the decoder replays wire ops with the same index helpers (see
 * arrayOps.ts).
 *
 * The common builtins (`forEach`, `map`, `filter`, `indexOf`, `slice`, …)
 * are overridden with index loops: V8 runs an `Array.prototype` builtin on
 * a subclass instance through its generic per-property path, far slower
 * than on a plain array. `for…of` / `values` / `keys` / `entries` hand out
 * a small iterator (the native one misses its fast path on a subclass).
 *
 * Mutations are recorded on an `ArrayLog` (see encoder/ArrayLog.ts): an
 * ordered op log with the values captured at record time. There is no
 * staged copy of the array and no per-index op merging.
 *
 * `Symbol.species` is `Array`: `map` / `filter` / `slice` / `concat` /
 * `flat` return plain arrays (a species of ArraySchema would make the
 * builtins call `new ArraySchema(n)`).
 */

/** The array `move()` is running its callback on: its `set()` writes go straight to the array. */
let moving: ArraySchema | undefined;

/** Live iterators — see the class comment. */
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

/** Attach a ref child. */
function attachChild(tree: ChangeTree, parent: any, value: any, index: number): void {
    refTreeOf(value)?.setParent(parent, tree.root, index, tree);
}

/** The window of the last `windowPermutation()`: `[windowStart, windowEnd)`. */
let windowStart = 0;
let windowEnd = 0;

/** `windowPermutation()` result for "the whole array, back to front". */
const REVERSED: number[] = [-1];

/** Windows up to this size are matched by scanning; larger ones through a Map. */
const SCAN_WINDOW_MAX = 8;

/**
 * The slots `after` holds differently from `before`, as a permutation of the
 * smallest window covering them: `perm[k]` = offset in the window of the old
 * position of the element now at `windowStart + k`. `[]` when the order is
 * unchanged, `REVERSED` when the whole array flipped, `undefined` when
 * `after` is not a permutation of `before` (membership changed). Equal
 * values pair up in order of occurrence.
 */
function windowPermutation(before: ArrayLike<any>, after: ArrayLike<any>): number[] | undefined {
    const n = before.length;
    if (after.length !== n) return undefined;
    let lo = 0;
    while (lo < n && before[lo] === after[lo]) lo++;
    if (lo === n) return [];
    let hi = n - 1;
    while (before[hi] === after[hi]) hi--;
    const w = hi - lo + 1;
    windowStart = lo;
    windowEnd = hi + 1;
    if (w === n) {
        let k = 0;
        while (k < n && after[k] === before[n - 1 - k]) k++;
        if (k === n) return REVERSED;
    }
    const perm: number[] = new Array(w);

    if (w <= SCAN_WINDOW_MAX) {
        let used = 0;
        for (let k = 0; k < w; k++) {
            const value = after[lo + k];
            let i = 0;
            for (; i < w; i++) {
                if ((used & (1 << i)) !== 0) continue;
                const old = before[lo + i];
                if (old === value || (old !== old && value !== value)) break; // NaN pairs with NaN, as in the Map
            }
            if (i === w) return undefined;
            used |= 1 << i;
            perm[k] = i;
        }
        return perm;
    }

    // first occurrence per value; `next` chains the later ones
    const first = new Map<any, number>();
    const next: number[] = new Array(w);
    for (let i = w - 1; i >= 0; i--) {
        const value = before[lo + i];
        const later = first.get(value);
        next[i] = (later === undefined) ? -1 : later;
        first.set(value, i);
    }
    for (let k = 0; k < w; k++) {
        const value = after[lo + k];
        const i = first.get(value);
        if (i === undefined || i === -1) return undefined;
        first.set(value, next[i]);
        perm[k] = i;
    }
    return perm;
}

/** Record a non-empty `windowPermutation()` result. */
function recordPermutation(tree: ChangeTree, perm: number[]): void {
    const log = tree.rec as ArrayLog;
    if (perm === REVERSED) log.reverse();
    else log.reorder(windowStart, perm);
    tree.touch();
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
    /** Index and `length` writes are not tracked: `set(index, value)`, `splice(n)`, `clear()`. */
    readonly [index: number]: V;
    declare readonly length: number;

    /** Prototype accessor; the tree itself is stamped on the instance (see ChangeTree.ts). */
    declare [$changes]: ChangeTree;
    declare [$refId]?: number;
    [$rev]?: number;

    protected [$childType]: string | typeof Schema;

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

    /** Tracked equivalent of `Array.from` (the native one writes by index). */
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

    /** Never `super(...items)`: a single number argument would allocate holes. */
    constructor(...items: V[]) {
        super();
        this[$childType] = undefined as any;

        const tree = createTree(this);
        stampTree(this, tree);

        if (items.length > 0) this.$pushAll(items);
    }

    /**
     * Decoder-side factory: an exotic Array with `ArraySchema.prototype`
     * whose constructor body never runs (no ChangeTree).
     */
    static initializeForDecoder<V = any>(): ArraySchema<V> {
        const self: any = Reflect.construct(Array, [], ArraySchema);
        self[$childType] = undefined;
        self[$rev] = 0;
        installUntrackedChangeTree(self);
        return self;
    }

    // ────── Change tracking control (same API as Schema) ──────
    pauseTracking(): void { treeOf(this).pause(); }
    resumeTracking(): void { treeOf(this).resume(); }
    untracked<T>(fn: () => T): T { return treeOf(this).untracked(fn); }
    get isTrackingPaused(): boolean { return treeOf(this).paused; }

    // ────── Mutations ──────

    push(...values: V[]): number {
        return this.$pushAll(values);
    }

    /** `push` without spreading (large inputs). */
    protected $pushAll(values: V[]): number {
        const self = this;
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
        const self = this;
        const length = self.length;
        if (length === 0) return undefined;

        const tree = treeOf(self);
        const value = self[length - 1];

        if (tree.tracking) {
            (tree.rec as ArrayLog).remove(length - 1, [value]);
            tree.touch();
        }

        (self as any[]).length = length - 1;
        releaseChild(tree, value);
        return value;
    }

    shift(): V | undefined {
        const self = this;
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
        const self = this;
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
        const self = this;
        const length = self.length;

        // normalize per the spec
        start = Math.trunc(start) || 0;
        if (start < 0) start = Math.max(length + start, 0);
        else if (start > length) start = length;
        deleteCount = (arguments.length === 1) // omitted ≠ explicit undefined (→ 0)
            ? length - start
            : Math.min(Math.max(Math.trunc(deleteCount!) || 0, 0), length - start);

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
     * Sorts in place and records one REORDER op covering the slots that
     * moved, instead of a REPLACE per index. Nothing is recorded when the
     * order is unchanged.
     */
    sort(compareFn?: (a: V, b: V) => number): this {
        const self = this;
        if (self.length < 2) return this;
        // sort a plain copy (the native sort is generic on a subclass receiver)
        const sorted = arrCopy(self).sort(compareFn);
        const perm = windowPermutation(self, sorted)!;
        if (perm.length === 0) return this;
        const tree = treeOf(self);
        if (tree.tracking) recordPermutation(tree, perm);
        for (let i = windowStart; i < windowEnd; i++) (self as V[])[i] = sorted[i];
        return this;
    }

    reverse(): this {
        const self = this;
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
        const self = this;
        const length = self.length;
        let from = start === undefined ? 0 : Math.trunc(start);
        let to = end === undefined ? length : Math.trunc(end);
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        for (let i = from; i < to; i++) self.set(i, value);
        return this;
    }

    copyWithin(target: number, start: number, end?: number): this {
        const self = this;
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
        for (let i = 0; i < count; i++) self.set(to + i, segment[i]);
        return this;
    }

    /**
     * Tracked `arr[index] = value`. A write past the end appends (the array
     * never holds holes); `undefined` / `null` removes the element.
     */
    set(index: number, value: V): this {
        const self = this as any[];
        if (moving === this) {
            self[index] = value;
            return this;
        }
        if (value === undefined || value === null) {
            if (index < self.length) this.splice(index, 1);
            return this;
        }

        const tree = treeOf(this);
        const childType = this[$childType];
        if (childType !== undefined && typeof value === "object") {
            assertInstanceType(value as any, childType as typeof Schema, this, index);
        }

        const length = self.length;
        if (index >= length) {
            if (tree.tracking) {
                (tree.rec as ArrayLog).push([value], length);
                tree.touch();
            }
            self[length] = value;
            if (typeof childType !== "string") attachChild(tree, tree.ref, value, length);
            return this;
        }

        const previousValue = self[index];
        if (previousValue === value) return this;

        if (tree.tracking) {
            (tree.rec as ArrayLog).set(index, previousValue, value);
            tree.touch();
        }
        self[index] = value;
        releaseChild(tree, previousValue);
        if (typeof childType !== "string") attachChild(tree, tree.ref, value, index);
        return this;
    }

    clear(): void {
        const self = this;
        if (self.length === 0) return;

        const tree = treeOf(self);
        for (let i = 0, len = self.length; i < len; i++) releaseChild(tree, self[i]);

        if (tree.tracking) {
            (tree.rec as ArrayLog).clear();
            tree.touch();
        }

        (self as any[]).length = 0;
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
    move(cb: (arr: V[]) => void): this {
        const self = this;
        const tree = treeOf(self);
        if (!tree.tracking) {
            cb(this);
            return this;
        }
        const before = arrCopy(self);
        moving = self;
        try { cb(this); } finally { moving = undefined; }

        const perm = windowPermutation(before, self);
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
            recordPermutation(tree, perm);
        }
        return this;
    }

    shuffle(): this {
        return this.move((arr) => {
            const self = arr;
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
        const self = this;
        const copy = arrCopy(self);
        if (index < 0) index += copy.length;
        if (index < 0 || index >= copy.length) throw new RangeError(`Invalid index : ${index}`);
        copy[index] = value;
        return copy;
    }

    toReversed(): V[] {
        return arrCopy(this).reverse();
    }

    toSorted(compareFn?: (a: V, b: V) => number): V[] {
        return arrCopy(this).sort(compareFn);
    }

    toSpliced(start: number, deleteCount?: number, ...items: V[]): V[] {
        const copy: V[] = arrCopy(this);
        // forward `arguments` so an omitted deleteCount differs from an explicit undefined
        copy.splice.apply(copy, arguments as any);
        return copy;
    }

    findLast<S extends V>(predicate: (value: V, index: number, array: this) => value is S, thisArg?: any): S | undefined;
    findLast(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): V | undefined;
    findLast(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): V | undefined {
        const self = this;
        for (let i = self.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, self[i], i, this)) return self[i];
        }
        return undefined;
    }

    findLastIndex(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): number {
        const self = this;
        for (let i = self.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, self[i], i, this)) return i;
        }
        return -1;
    }

    // ────── Read-side builtins as index loops (see the class comment) ──────
    // Without a `thisArg` the callback is called directly (`Function#call`
    // costs a builtin call per element until TurboFan inlines it, and on
    // polymorphic callers). A direct call passes `this = undefined` exactly
    // like `.call(undefined, …)`, so the two branches are equivalent.

    forEach(callbackfn: (value: V, index: number, array: this) => void, thisArg?: any): void {
        const self = this;
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) callbackfn(self[i], i, this);
        } else {
            for (let i = 0; i < len; i++) callbackfn.call(thisArg, self[i], i, this);
        }
    }

    map<U>(callbackfn: (value: V, index: number, array: this) => U, thisArg?: any): U[] {
        const self = this;
        const len = self.length;
        const out: U[] = new Array(len);
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) out[i] = callbackfn(self[i], i, this);
        } else {
            for (let i = 0; i < len; i++) out[i] = callbackfn.call(thisArg, self[i], i, this);
        }
        return out;
    }

    filter<S extends V>(predicate: (value: V, index: number, array: this) => value is S, thisArg?: any): S[];
    filter(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): V[];
    filter(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): V[] {
        const self = this;
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

    find<S extends V>(predicate: (value: V, index: number, obj: this) => value is S, thisArg?: any): S | undefined;
    find(predicate: (value: V, index: number, obj: this) => unknown, thisArg?: any): V | undefined;
    find(predicate: (value: V, index: number, obj: this) => unknown, thisArg?: any): V | undefined {
        // (returns the value captured before the predicate ran, as the spec does)
        const self = this;
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) { const value = self[i]; if (predicate(value, i, this)) return value; }
        } else {
            for (let i = 0; i < len; i++) { const value = self[i]; if (predicate.call(thisArg, value, i, this)) return value; }
        }
        return undefined;
    }

    findIndex(predicate: (value: V, index: number, obj: this) => unknown, thisArg?: any): number {
        const self = this;
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) if (predicate(self[i], i, this)) return i;
        } else {
            for (let i = 0; i < len; i++) if (predicate.call(thisArg, self[i], i, this)) return i;
        }
        return -1;
    }

    some(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): boolean {
        return this.findIndex(predicate, thisArg) !== -1;
    }

    every<S extends V>(predicate: (value: V, index: number, array: this) => value is S, thisArg?: any): this is S[];
    every(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): boolean;
    every(predicate: (value: V, index: number, array: this) => unknown, thisArg?: any): boolean {
        const self = this;
        const len = self.length;
        if (thisArg === undefined) {
            for (let i = 0; i < len; i++) if (!predicate(self[i], i, this)) return false;
        } else {
            for (let i = 0; i < len; i++) if (!predicate.call(thisArg, self[i], i, this)) return false;
        }
        return true;
    }

    reduce(callbackfn: (previousValue: V, currentValue: V, currentIndex: number, array: this) => V): V;
    reduce(callbackfn: (previousValue: V, currentValue: V, currentIndex: number, array: this) => V, initialValue: V): V;
    reduce<U>(callbackfn: (previousValue: U, currentValue: V, currentIndex: number, array: this) => U, initialValue: U): U;
    reduce(callbackfn: (previousValue: any, currentValue: V, currentIndex: number, array: this) => any, initialValue?: any): any {
        const self = this;
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
        const self = this;
        const length = self.length;
        const from = forwardFrom(fromIndex, length);
        if (from === -1) return -1;
        return indexOfKind(self, searchElement, from, length);
    }

    lastIndexOf(searchElement: V, fromIndex?: number): number {
        const self = this;
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
        const self = this;
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
        const self = this;
        const length = self.length;
        let from = (start === undefined) ? 0 : Math.trunc(start) || 0;
        let to = (end === undefined) ? length : Math.trunc(end) || 0;
        if (from < 0) from = Math.max(length + from, 0); else from = Math.min(from, length);
        if (to < 0) to = Math.max(length + to, 0); else to = Math.min(to, length);
        return arrCopy(self, from, to);
    }

    at(index: number): V | undefined {
        const self = this;
        index = Math.trunc(index) || 0;
        if (index < 0) index += self.length;
        return self[index];
    }

    [Symbol.iterator](): ReturnType<Array<V>[typeof Symbol.iterator]> {
        return new ArrayValues(this) as any;
    }

    values(): ReturnType<Array<V>["values"]> {
        return new ArrayValues(this) as any;
    }

    keys(): ReturnType<Array<V>["keys"]> {
        return new ArrayKeys(this) as any;
    }

    entries(): ReturnType<Array<V>["entries"]> {
        return new ArrayEntries(this) as any;
    }

    // ────── Encoder / decoder plumbing ──────

    get [$elements](): V[] {
        return this as V[];
    }

    [$getByIndex](index: number): any {
        return this[index];
    }

    [$deleteByIndex](index: number): void {
        arrRemove(this, index, 1);
    }

    /**
     * Pool reset: empty this array and recycle its ChangeTree WITHOUT recording
     * any wire op (the parent field's ADD/DELETE owns the wire). Recurses into
     * ref-type children. Called by Schema.reset when a pooled entity has an
     * array field. The instance must already be detached from the encoder.
     */
    [$reset]() {
        const self = this;
        const tree = treeOf(self);
        for (let i = 0, len = self.length; i < len; i++) (self[i] as any)?.[$reset]?.();
        (self as any[]).length = 0;
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
        const self = this as V[];
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
        return arrCopy(this);
    }

    toJSON(): (V extends { toJSON(...args: any[]): infer R } ? R : V)[] {
        const self = this;
        const length = self.length;
        const out = new Array(length);
        for (let i = 0; i < length; i++) {
            const value: any = self[i];
            out[i] = (typeof value?.toJSON === "function") ? value.toJSON() : value;
        }
        return out;
    }

    clone(): ArraySchema<V> {
        const self = this;
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
