import { ChangeTree } from "../changes/ChangeTree";
import { Schema, SchemaDecoderCallbacks } from "../Schema";
import { OPERATION } from "../spec";

//
// Notes:
// -----
//
// - The tsconfig.json of @colyseus/schema uses ES2018.
// - ES2019 introduces `flatMap` / `flat`, which is not currently relevant, and caused other issues.
//

export function getArrayProxy(value: ArraySchema) {
    value['$proxy'] = true;

    //
    // compatibility with @colyseus/schema 0.5.x
    // - allow `map["key"]`
    // - allow `map["key"] = "xxx"`
    // - allow `delete map["key"]`
    //
    value = new Proxy(value, {
        get: (obj, prop) => {
            if (
                typeof (prop) !== "symbol" &&
                !isNaN(prop as any) // https://stackoverflow.com/a/175787/892698
            ) {
                return obj['$items'][prop];

            } else {
                return obj[prop];
            }
        },

        set: (obj, prop, setValue) => {
            if (
                typeof (prop) !== "symbol" &&
                !isNaN(prop as any)
            ) {
                obj.setAt(Number(prop), setValue);

            } else {
                obj[prop] = setValue;
            }

            return true;
        },

        deleteProperty: (obj, prop) => {
            if (typeof (prop) === "number") {

                //
                // TOOD: touch `$changes`
                //
                delete obj['$items'][prop];

            } else {
                delete obj[prop];
            }

            return true;
        },
    });

    return value;
}

export class ArraySchema<T=any> implements Array<T>, SchemaDecoderCallbacks {
    protected $changes: ChangeTree = new ChangeTree(this);

    protected $items: Array<T> = [];
    // protected $indexes: number[] = [];

    [n: number]: T;

    //
    // Decoding callbacks
    //
    public onAdd?: (item: T, index: number) => void;
    public onRemove?: (item: T, index: number) => void;
    public onChange?: (item: T, index: number) => void;

    static is(type: any) {
        return Array.isArray(type);
    }

    constructor (...items: T[]) {
        this.push(...items);
    }

    get length() {
        return this.$items.length;
    }

    /**
     * Removes the last element from an array and returns it.
     */
    pop(): T | undefined {
        const index = this.$items.length - 1;

        // const index = this.$indexes.pop();
        // if (index === undefined) { return undefined; }

        const value = this.$items.pop();
        this.$changes.delete(index);

        delete this.$changes.indexes[index];

        return value;
    }

    /**
     * Appends new elements to an array, and returns the new length of the array.
     * @param items New elements of the Array.
     */
    push(...items: T[]): number {
        let length: number;

        for (const item of items) {
            this.setAt(this.length, item);
        }

        return length;
    }

    /**
     * Combines two or more arrays.
     * @param items Additional items to add to the end of array1.
     */
    concat(...items: (T | ConcatArray<T>)[]): T[] {
        return new ArraySchema(...this.$items.concat(...items));
    }

    /**
     * Adds all the elements of an array separated by the specified separator string.
     * @param separator A string used to separate one element of an array from the next in the resulting String. If omitted, the array elements are separated with a comma.
     */
    join(separator?: string): string { return this.$items.join(separator); }

    /**
     * Reverses the elements in an Array.
     */
    reverse(): T[] {
        //
        // TODO: touch `$changes`
        //
        this.$items.reverse();

        return this;
    }

    /**
     * Removes the first element from an array and returns it.
     */
    shift(): T | undefined {
        this.$changes.delete(0);

        // this.$indexes.shift();
        this.moveIndexes(1, this.$items.length, -1);

        const shifted = this.$items.shift();

        console.log("SHIFT", {
            $items: this.$items,
            // $indexes: this.$indexes,
            $changes: this.$changes.changes,
        });

        return shifted;
    }

    /**
     * Returns a section of an array.
     * @param start The beginning of the specified portion of the array.
     * @param end The end of the specified portion of the array. This is exclusive of the element at the index 'end'.
     */
    slice(start?: number, end?: number): T[] {
        return new ArraySchema(...this.$items.slice(start, end));
    }

    /**
     * Sorts an array.
     * @param compareFn Function used to determine the order of the elements. It is expected to return
     * a negative value if first argument is less than second argument, zero if they're equal and a positive
     * value otherwise. If omitted, the elements are sorted in ascending, ASCII character order.
     * ```ts
     * [11,2,22,1].sort((a, b) => a - b)
     * ```
     */
    sort(compareFn?: (a: T, b: T) => number): this {
        this.$items.sort(compareFn);

        this.$items.forEach((value, index) => this.setAt(index, value));

        return this;
    }

    /**
     * Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
     * @param start The zero-based location in the array from which to start removing elements.
     * @param deleteCount The number of elements to remove.
     * @param items Elements to insert into the array in place of the deleted elements.
     */
    splice(
        start: number,
        deleteCount: number = this.length - start,
        ...items: T[]
    ): T[] {
        //
        // TODO: add `items`, consider `items.length` when moving indexes
        //

        // console.log("BEFORE SPLICE", {
        //     $indexes: this.$indexes,
        //     $items: this.$items,
        //     $changes: this.$changes.changes,
        // })

        const previousLength = this.$items.length;

        const removedItems = this.$items.splice(start, deleteCount); // , ...items
        // const removedIndexes = this.$indexes.splice(start, deleteCount); // TODO: add new indexes here

        // // perform DELETE operations on reverse order.
        // removedIndexes
        //     .reverse()
        //     .forEach((removedIndex, i) => {
        //         this.$changes.delete(removedIndex);
        //         delete this.$changes.indexes[removedIndex];

        //         // `pop` latest items of the array.
        //         const popIndex = previousLength - i;
        //         this.$changes.delete(popIndex);
        //         delete this.$changes.indexes[popIndex];
        //     });

        // decrement `index` of all "changes" after items removed.
        Array.from(this.$changes.changes.entries()).forEach(([_, change]) => {
                console.log("ITERATING OVER CHANGES => ", {
                    change, start, deleteCount,
                });

                if (change.index > start) {
                    if (change.op !== OPERATION.DELETE) {
                        this.$changes.delete(change.index);
                    }

                    change.index -= start;
                    this.$changes.changes.set(change.index, change);

                    console.log("MOVE", change.index + start, "TO", change.index, this.$changes.changes);
                }
            });

        console.log("MOVE INDEXES:", start + deleteCount - 1);
        // this.moveIndexes(start + deleteCount - 1);

        // console.log("AFTER SPLICE", {
        //     $indexes: this.$indexes,
        //     $items: this.$items,
        //     $changes: this.$changes.changes,
        // })

        this.$changes.allChanges = new Set(this.$items.keys());

        return removedItems;
    }

    /**
     * Inserts new elements at the start of an array.
     * @param items  Elements to insert at the start of the Array.
     */
    unshift(...items: T[]): number {
        //
        // TODO: touch $changes
        //
        const result = this.$items.unshift(...items);
        return result;
    }

    /**
     * Returns the index of the first occurrence of a value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at index 0.
     */
    indexOf(searchElement: T, fromIndex?: number): number {
        return this.$items.indexOf(searchElement, fromIndex);
    }

    /**
     * Returns the index of the last occurrence of a specified value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at the last index in the array.
     */
    lastIndexOf(searchElement: T, fromIndex?: number): number {
        return this.$items.indexOf(searchElement, fromIndex);
    }

    /**
     * Determines whether all the members of an array satisfy the specified test.
     * @param callbackfn A function that accepts up to three arguments. The every method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value false, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    every(callbackfn: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean {
        return this.$items.every(callbackfn, thisArg);
    }

    /**
     * Determines whether the specified callback function returns true for any element of an array.
     * @param callbackfn A function that accepts up to three arguments. The some method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value true, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    some(callbackfn: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean {
        return this.$items.some(callbackfn, thisArg);
    }

    /**
     * Performs the specified action for each element in an array.
     * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the array.
     * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void {
        this.$items.forEach(callbackfn, thisArg);
    }

    /**
     * Calls a defined callback function on each element of an array, and returns an array that contains the results.
     * @param callbackfn A function that accepts up to three arguments. The map method calls the callbackfn function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[] {
        return this.$items.map(callbackfn, thisArg);
    }

    /**
     * Returns the elements of an array that meet the condition specified in a callback function.
     * @param callbackfn A function that accepts up to three arguments. The filter method calls the callbackfn function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    filter(callbackfn: (value: T, index: number, array: T[]) => unknown, thisArg?: any)
    filter<S extends T>(callbackfn: (value: T, index: number, array: T[]) => value is S, thisArg?: any): T[] {
        return this.$items.filter(callbackfn, thisArg);
        // const filtered = new ArraySchema(
        //     ...
        // );

        // filtered.$changes = this.$changes.clone();

        // return filtered;
    }

    /**
     * Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduce method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduce<U=T>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue?: U): U {
        return this.$items.reduce(callbackfn, initialValue);
    }

    /**
     * Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduceRight method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduceRight<U=T>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue?: U): U {
        return this.$items.reduceRight(callbackfn, initialValue);
    }

    /**
     * Returns the value of the first element in the array where predicate is true, and undefined
     * otherwise.
     * @param predicate find calls predicate once for each element of the array, in ascending
     * order, until it finds one where predicate returns true. If such an element is found, find
     * immediately returns that element value. Otherwise, find returns undefined.
     * @param thisArg If provided, it will be used as the this value for each invocation of
     * predicate. If it is not provided, undefined is used instead.
     */
    find<S extends T>(predicate: (this: void, value: T, index: number, obj: T[]) => value is S, thisArg?: any): S | undefined
    find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined {
        return this.$items.find(predicate, thisArg);
    }

    /**
     * Returns the index of the first element in the array where predicate is true, and -1
     * otherwise.
     * @param predicate find calls predicate once for each element of the array, in ascending
     * order, until it finds one where predicate returns true. If such an element is found,
     * findIndex immediately returns that element index. Otherwise, findIndex returns -1.
     * @param thisArg If provided, it will be used as the this value for each invocation of
     * predicate. If it is not provided, undefined is used instead.
     */
    findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number {
        return this.$items.findIndex(predicate, thisArg);
    }

    /**
     * Returns the this object after filling the section identified by start and end with value
     * @param value value to fill array section with
     * @param start index to start filling the array at. If start is negative, it is treated as
     * length+start where length is the length of the array.
     * @param end index to stop filling the array at. If end is negative, it is treated as
     * length+end.
     */
    fill(value: T, start?: number, end?: number): this {
        //
        // TODO: touch `$changes`.
        //
        this.$items.fill(value, start, end);

        return this;
    }

    /**
     * Returns the this object after copying a section of the array identified by start and end
     * to the same array starting at position target
     * @param target If target is negative, it is treated as length+target where length is the
     * length of the array.
     * @param start If start is negative, it is treated as length+start. If end is negative, it
     * is treated as length+end.
     * @param end If not specified, length of the this object is used as its default value.
     */
    copyWithin(target: number, start: number, end?: number): this {
        //
        // TODO: touch `$changes`.
        //
        this.$items.copyWithin(target, start, end);

        return this;
    }

    /**
     * Returns a string representation of an array.
     */
    toString(): string { return this.$items.toString(); }

    /**
     * Returns a string representation of an array. The elements are converted to string using their toLocalString methods.
     */
    toLocaleString(): string { return this.$items.toLocaleString() };

    clone(isDecoding?: boolean): ArraySchema<T> {
        let cloned: ArraySchema;

        if (isDecoding) {
            cloned = new ArraySchema(...this.$items);
            cloned.onAdd = this.onAdd;
            cloned.onRemove = this.onRemove;
            cloned.onChange = this.onChange;

        } else {
            cloned = new ArraySchema(...this.$items.map(item => (
                (item['$changes'])
                    ? (item as any as Schema).clone()
                    : item
            )));
        }

        return cloned;
    };

    /** Iterator */
    [Symbol.iterator](): IterableIterator<T> { return this.$items[Symbol.iterator](); }
    [Symbol.unscopables]() { return this.$items[Symbol.unscopables](); }

    /**
     * Returns an iterable of key, value pairs for every entry in the array
     */
    entries(): IterableIterator<[number, T]> { return this.$items.entries(); }

    /**
     * Returns an iterable of keys in the array
     */
    keys(): IterableIterator<number> { return this.$items.keys(); }

    /**
     * Returns an iterable of values in the array
     */
    values(): IterableIterator<T> { return this.$items.values(); }

    /**
     * Determines whether an array includes a certain element, returning true or false as appropriate.
     * @param searchElement The element to search for.
     * @param fromIndex The position in this array at which to begin searching for searchElement.
     */
    includes(searchElement: T, fromIndex?: number): boolean {
        return this.$items.includes(searchElement, fromIndex);
    }

    clear() {
        // discard previous operations.
        this.$changes.discard();

        // clear items
        this.$items = [];

        this.$changes.operation({ index: 0, op: OPERATION.CLEAR });

        // touch all structures until reach root
        this.$changes.touchParents();
    }

    protected setIndex(index: number, key: number) {
        // this.$indexes[index] = key;
    }

    protected getIndex(index: number) {
        // return this.$indexes[index];
        return index;
    }

    protected getByIndex(index: number) {
        // return this.$items[this.$indexes[index]];
        return this.$items[index];
    }

    setAt(key: number, item: T) {
        // set "index" for reference.
        const index = key;

        if (item['$changes']) {
            (item['$changes'] as ChangeTree).setParent(
                this,
                this.$changes.root,
                index,
            );
        }

        this.$items[key] = item;

        this.$changes.indexes[key] = index;
        // this.$indexes[index] = key;

        // console.log(`ArraySchema#setAt() =>`, { isRef, key, index, item });

        this.$changes.change(key);
    }

    protected deleteByIndex(index: number) {
        // const key = this.$indexes[index];
        const key = index;

        if (key === undefined) {
            // console.log("SKIP deleteByIndex", { index, key, $indexes: this.$indexes });
            console.log("SKIP deleteByIndex", { index });
            return;
        }

        console.log("deleteByIndex:", { key, $items: this.$items });

        this.$items.splice(key, 1);
        // this.$indexes.splice(key, 1);

        // this.moveIndexes(key, this.$items.length, -1);
    }

    protected moveIndexes(fromIndex: number, toIndex: number = this.$items.length, shift: number = -1) {
        console.log("MOVE INDEXES, BEFORE =>", this.$changes.changes);

        //
        // we only move indexes when items are being removed.
        // use reverse order to ensure no index is getting replaced.
        //
        for (let i = toIndex - 1; i >= fromIndex; i--) {
            const changeAt = this.$changes.changes.get(i);
            if (changeAt) {
                changeAt.index += shift;
                this.$changes.changes.set(changeAt.index + shift, changeAt);
            } else {
                console.warn("ITEM NOT FOUND AT", { i });
            }
        }

        console.log("MOVE INDEXES, AFTER =>", this.$changes.changes);

        // //
        // // reduce the correspondance of next items (after the removed item)
        // //
        // for (let i = fromIndex; i < this.$indexes.length; i++) {
        //     this.$indexes[i] += shift;

        //     // const changeAtIndex = this.$changes.changes.get(i);
        //     // if (changeAtIndex) {
        //     //     changeAtIndex.index += shift;
        //     // }
        // }
    }

    triggerAll() {
        if (!this.onAdd) { return; }
        for (let i = 0; i < this.length; i++) {
            this.onAdd(this[i], i);
        }
    }

    toJSON() {
        const arr = [];
        for (let i = 0; i < this.length; i++) {
            const objAt = this.$items[i];
            arr.push(
                (objAt && typeof (objAt['toJSON']) === "function")
                    ? objAt['toJSON']()
                    : objAt
            );
        }
        return arr;
    }

    toArray() {
        return this.$items;
    }

}