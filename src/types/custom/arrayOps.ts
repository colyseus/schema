/**
 * Element moves for `ArraySchema` instances (encoder and decoder side).
 *
 * V8 takes the fast path of an `Array.prototype` builtin (`shift`, `splice`,
 * `unshift`, `slice`, `indexOf`, `forEach`, `map`, …) only when the receiver's
 * prototype is the initial `Array.prototype`. On an Array *subclass* instance
 * every one of them runs the generic per-property algorithm — two orders of
 * magnitude slower on a few thousand elements. Plain keyed loads and stores
 * are fast on any array with fast elements, so everything here moves
 * elements by index. `length` only ever grows by one, through a keyed store
 * at `length` (the array stays packed), or is assigned to truncate.
 */

/** Plain-array copy of `arr[start, end)`. */
export function arrCopy<V>(arr: ArrayLike<V>, start: number = 0, end: number = arr.length): V[] {
    const n = end - start;
    if (n <= 0) return [];
    const out: V[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[start + i];
    return out;
}

/** Strict-equality search from `from` (no holes: equivalent to `Array#indexOf`). */
export function arrIndexOf<V>(arr: ArrayLike<V>, value: V, from: number = 0): number {
    for (let i = from, len = arr.length; i < len; i++) {
        if (arr[i] === value) return i;
    }
    return -1;
}

/** Append `values` (keyed stores at `length`). */
export function arrAppend<V>(arr: V[], values: ArrayLike<V>): void {
    let at = arr.length;
    for (let i = 0, n = values.length; i < n; i++) arr[at++] = values[i];
}

/** Remove `count` elements at `index` (the tail slides left, then truncate). */
export function arrRemove<V>(arr: V[], index: number, count: number): void {
    const len = arr.length;
    for (let j = index + count; j < len; j++) arr[j - count] = arr[j];
    arr.length = len - count;
}

/** Insert `values` at `index` (append them, slide the tail right, write them in place). */
export function arrInsert<V>(arr: V[], index: number, values: ArrayLike<V>): void {
    const n = values.length;
    if (n === 0) return;
    const len = arr.length;
    for (let k = 0; k < n; k++) arr[len + k] = values[k];
    for (let j = len - 1; j >= index; j--) arr[j + n] = arr[j];
    for (let k = 0; k < n; k++) arr[index + k] = values[k];
}

/** Insert one value at `index`. */
export function arrInsertOne<V>(arr: V[], index: number, value: V): void {
    const len = arr.length;
    arr[len] = value;
    for (let j = len - 1; j >= index; j--) arr[j + 1] = arr[j];
    arr[index] = value;
}

/**
 * `Array#splice` with normalized arguments: removes `deleteCount` elements
 * at `start`, inserts `items` there, returns the removed elements as a plain
 * array. One slide of the tail whatever the size difference.
 */
export function arrSplice<V>(arr: V[], start: number, deleteCount: number, items: ArrayLike<V>): V[] {
    const removed = arrCopy(arr, start, start + deleteCount);
    const n = items.length;
    const delta = n - deleteCount;
    if (delta < 0) {
        arrRemove(arr, start + n, -delta);
    } else if (delta > 0) {
        const len = arr.length;
        for (let k = 0; k < delta; k++) arr[len + k] = items[n - delta + k]; // grow packed
        for (let j = len - 1; j >= start + deleteCount; j--) arr[j + delta] = arr[j];
    }
    for (let k = 0; k < n; k++) arr[start + k] = items[k];
    return removed;
}

/** In-place reverse. */
export function arrReverse<V>(arr: V[]): void {
    for (let i = 0, j = arr.length - 1; i < j; i++, j--) {
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
}
