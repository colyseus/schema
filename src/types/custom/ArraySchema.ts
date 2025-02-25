import { $changes, $childType, $decoder, $deleteByIndex, $onEncodeEnd, $encoder, $filter, $getByIndex, $onDecodeEnd } from "../symbols";
import type { Schema } from "../../Schema";
import { ChangeTree, setOperationAtIndex } from "../../encoder/ChangeTree";
import { OPERATION } from "../../encoding/spec";
import { registerType } from "../registry";
import { Collection } from "../HelperTypes";

import { encodeArray } from "../../encoder/EncodeOperation";
import { decodeArray } from "../../decoder/DecodeOperation";
import type { StateView } from "../../encoder/StateView";
import { assertInstanceType } from "../../encoding/assert";

const DEFAULT_SORT = (a: any, b: any) => {
    const A = a.toString();
    const B = b.toString();
    if (A < B) return -1;
    else if (A > B) return 1;
    else return 0
}

export class ArraySchema<V = any> implements Array<V>, Collection<number, V> {
    [n: number]: V;

    protected items: V[] = [];
    protected tmpItems: V[] = [];
    protected deletedIndexes: {[index: number]: boolean} = {};

    static [$encoder] = encodeArray;
    static [$decoder] = decodeArray;

    /**
     * Determine if a property must be filtered.
     * - If returns false, the property is NOT going to be encoded.
     * - If returns true, the property is going to be encoded.
     *
     * Encoding with "filters" happens in two steps:
     * - First, the encoder iterates over all "not owned" properties and encodes them.
     * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
     */
    static [$filter] (ref: ArraySchema, index: number, view: StateView) {
        return (
            !view ||
            typeof (ref[$childType]) === "string" ||
            // view.items.has(ref[$getByIndex](index)[$changes])
            view.items.has(ref['tmpItems'][index]?.[$changes])
        );
    }

    static is(type: any) {
        return (
            // type format: ["string"]
            Array.isArray(type) ||

            // type format: { array: "string" }
            (type['array'] !== undefined)
        );
    }

    static from<T>(iterable: Iterable<T> | ArrayLike<T>) {
        return new ArraySchema<T>(...Array.from(iterable));
    }

    constructor (...items: V[]) {

        Object.defineProperty(this, $childType, {
            value: undefined,
            enumerable: false,
            writable: true,
            configurable: true,
        });

        const proxy = new Proxy(this, {
            get: (obj, prop) => {
                if (
                    typeof (prop) !== "symbol" &&
                    // FIXME: d8 accuses this as low performance
                    !isNaN(prop as any) // https://stackoverflow.com/a/175787/892698
                ) {
                    return this.items[prop];

                } else {
                    return Reflect.get(obj, prop);
                }
            },

            set: (obj, key, setValue) => {
                if (typeof (key) !== "symbol" && !isNaN(key as any)) {
                    if (setValue === undefined || setValue === null) {
                        obj.$deleteAt(key as unknown as number);

                    } else {
                        if (setValue[$changes]) {
                            assertInstanceType(setValue, obj[$childType] as typeof Schema, obj, key);

                            const previousValue = obj.items[key as unknown as number];
                            if (previousValue !== undefined) {
                                if (setValue[$changes].isNew) {
                                    this[$changes].indexedOperation(Number(key), OPERATION.MOVE_AND_ADD);

                                } else {
                                    if ((obj[$changes].getChange(Number(key)) & OPERATION.DELETE) === OPERATION.DELETE) {
                                        this[$changes].indexedOperation(Number(key), OPERATION.DELETE_AND_MOVE);
                                    } else {
                                        this[$changes].indexedOperation(Number(key), OPERATION.MOVE);
                                    }
                                }

                                // remove root reference from previous value
                                previousValue[$changes].root?.remove(previousValue[$changes]);

                            } else if (setValue[$changes].isNew) {
                                this[$changes].indexedOperation(Number(key), OPERATION.ADD);
                            }

                            setValue[$changes].setParent(this, obj[$changes].root, key);

                        } else {
                            obj.$changeAt(Number(key), setValue);
                        }

                        this.items[key as unknown as number] = setValue;
                        this.tmpItems[key as unknown as number] = setValue;
                    }

                    return true;
                } else {
                    return Reflect.set(obj, key, setValue);
                }
            },

            deleteProperty: (obj, prop) => {
                if (typeof (prop) === "number") {
                    obj.$deleteAt(prop);

                } else {
                    delete obj[prop];
                }

                return true;
            },

            has: (obj, key) => {
                if (typeof (key) !== "symbol" && !isNaN(Number(key))) {
                    return Reflect.has(this.items, key);
                }
                return Reflect.has(obj, key)
            }
        });

        this[$changes] = new ChangeTree(proxy);
        this[$changes].indexes = {};

        if (items.length > 0) {
            this.push(...items);
        }

        return proxy;
    }

    set length (newLength: number) {
        if (newLength === 0) {
            this.clear();
        } else if (newLength < this.items.length) {
            this.splice(newLength, this.length - newLength);
        } else {
            console.warn("ArraySchema: can't set .length to a higher value than its length.");
        }
    }

    get length() {
        return this.items.length;
    }

    push(...values: V[]) {
        let length = this.tmpItems.length;

        const changeTree = this[$changes];

        // values.forEach((value, i) => {

        for (let i = 0, l = values.length; i < values.length; i++, length++) {
            const value = values[i];

            if (value === undefined || value === null) {
                // skip null values
                return;

            } else if (typeof (value) === "object" && this[$childType]) {
                assertInstanceType(value as any, this[$childType] as typeof Schema, this, i);
                // TODO: move value[$changes]?.setParent() to this block.
            }

            changeTree.indexedOperation(length, OPERATION.ADD, this.items.length);

            this.items.push(value);
            this.tmpItems.push(value);

            //
            // set value's parent after the value is set
            // (to avoid encoding "refId" operations before parent's "ADD" operation)
            //
            value[$changes]?.setParent(this, changeTree.root, length);
        }

        //     length++;
        // });

        return length;
    }

    /**
     * Removes the last element from an array and returns it.
     */
    pop(): V | undefined {
        let index: number = -1;

        // find last non-undefined index
        for (let i = this.tmpItems.length - 1; i >= 0; i--) {
            // if (this.tmpItems[i] !== undefined) {
            if (this.deletedIndexes[i] !== true) {
                index = i;
                break;
            }
        }

        if (index < 0) {
            return undefined;
        }

        this[$changes].delete(index, undefined, this.items.length - 1);

        // this.tmpItems[index] = undefined;
        // this.tmpItems.pop();

        this.deletedIndexes[index] = true;

        return this.items.pop();
    }

    at(index: number) {
        // Allow negative indexing from the end
        if (index < 0) index += this.length;
        return this.items[index];
    }

    // encoding only
    protected $changeAt(index: number, value: V) {
        if (value === undefined || value === null) {
            console.error("ArraySchema items cannot be null nor undefined; Use `deleteAt(index)` instead.");
            return;
        }

        // skip if the value is the same as cached.
        if (this.items[index] === value) {
            return;
        }

        const changeTree = this[$changes];
        const operation = changeTree.indexes?.[index]?.op ?? OPERATION.ADD;

        changeTree.change(index, operation);

        //
        // set value's parent after the value is set
        // (to avoid encoding "refId" operations before parent's "ADD" operation)
        //
        value[$changes]?.setParent(this, changeTree.root, index);
    }

    // encoding only
    protected $deleteAt(index: number, operation?: OPERATION) {
        this[$changes].delete(index, operation);
    }

    // decoding only
    protected $setAt(index: number, value: V, operation: OPERATION) {
        if (
            index === 0 &&
            operation === OPERATION.ADD &&
            this.items[index] !== undefined
        ) {
            // handle decoding unshift
            this.items.unshift(value);

        } else if (operation === OPERATION.DELETE_AND_MOVE) {
            this.items.splice(index, 1);
            this.items[index] = value;

        } else {
            this.items[index] = value;
        }
    }

    clear() {
        // skip if already clear
        if (this.items.length === 0) {
            return;
        }

        // discard previous operations.
        const changeTree = this[$changes];

        // discard children
        changeTree.forEachChild((changeTree, _) => {
            changeTree.discard(true);

            //
            // TODO: add tests with instance sharing + .clear()
            // FIXME: this.root? is required because it is being called at decoding time.
            //
            // TODO: do not use [$changes] at decoding time.
            //
            const root = changeTree.root;
            if (root !== undefined) {
                root.removeChangeFromChangeSet("changes", changeTree);
                root.removeChangeFromChangeSet("allChanges", changeTree);
                root.removeChangeFromChangeSet("allFilteredChanges", changeTree);
            }
        });

        changeTree.discard(true);
        changeTree.operation(OPERATION.CLEAR);

        this.items.length = 0;
        this.tmpItems.length = 0;
    }

    /**
     * Combines two or more arrays.
     * @param items Additional items to add to the end of array1.
     */
    // @ts-ignore
    concat(...items: (V | ConcatArray<V>)[]): ArraySchema<V> {
        return new ArraySchema(...this.items.concat(...items));
    }

    /**
     * Adds all the elements of an array separated by the specified separator string.
     * @param separator A string used to separate one element of an array from the next in the resulting String. If omitted, the array elements are separated with a comma.
     */
    join(separator?: string): string {
        return this.items.join(separator);
    }

    /**
     * Reverses the elements in an Array.
     */
    // @ts-ignore
    reverse(): ArraySchema<V> {
        this[$changes].operation(OPERATION.REVERSE);
        this.items.reverse();
        this.tmpItems.reverse();
        return this;
    }

    /**
     * Removes the first element from an array and returns it.
     */
    shift(): V | undefined {
        if (this.items.length === 0) { return undefined; }

        // const index = Number(Object.keys(changeTree.indexes)[0]);
        const index = this.tmpItems.findIndex((item, i) => item === this.items[0]);
        const changeTree = this[$changes];

        changeTree.delete(index);
        changeTree.shiftAllChangeIndexes(-1, index);

        // this.deletedIndexes[index] = true;

        return this.items.shift();
    }

    /**
     * Returns a section of an array.
     * @param start The beginning of the specified portion of the array.
     * @param end The end of the specified portion of the array. This is exclusive of the element at the index 'end'.
     */
    slice(start?: number, end?: number): V[] {
        const sliced = new ArraySchema<V>();
        sliced.push(...this.items.slice(start, end));
        return sliced as unknown as V[];
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
    sort(compareFn: (a: V, b: V) => number = DEFAULT_SORT): this {
        const changeTree = this[$changes];
        const sortedItems = this.items.sort(compareFn);

        // wouldn't OPERATION.MOVE make more sense here?
        sortedItems.forEach((_, i) => changeTree.change(i, OPERATION.REPLACE));

        this.tmpItems.sort(compareFn);
        return this;
    }

    /**
     * Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
     * @param start The zero-based location in the array from which to start removing elements.
     * @param deleteCount The number of elements to remove.
     * @param insertItems Elements to insert into the array in place of the deleted elements.
     */
    splice(
        start: number,
        deleteCount: number = this.items.length - start,
        ...insertItems: V[]
    ): V[] {
        const changeTree = this[$changes];

        const tmpItemsLength = this.tmpItems.length;
        const insertCount = insertItems.length;

        // build up-to-date list of indexes, excluding removed values.
        const indexes: number[] = [];
        for (let i = 0; i < tmpItemsLength; i++) {
            // if (this.tmpItems[i] !== undefined) {
            if (this.deletedIndexes[i] !== true) {
                indexes.push(i);
            }
        }

        // delete operations at correct index
        for (let i = start; i < start + deleteCount; i++) {
            const index = indexes[i];
            changeTree.delete(index);
            // this.tmpItems[index] = undefined;
            this.deletedIndexes[index] = true;
        }

        // force insert operations
        for (let i = 0; i < insertCount; i++) {
            const addIndex = indexes[start] + i;
            changeTree.indexedOperation(addIndex, OPERATION.ADD);

            // set value's parent/root
            insertItems[i][$changes]?.setParent(this, changeTree.root, addIndex);
        }

        //
        // delete exceeding indexes from "allChanges"
        // (prevent .encodeAll() from encoding non-existing items)
        //
        if (deleteCount > insertCount) {
            changeTree.shiftAllChangeIndexes(-(deleteCount - insertCount), indexes[start + insertCount]);
        }

        return this.items.splice(start, deleteCount, ...insertItems);
    }

    /**
     * Inserts new elements at the start of an array.
     * @param items  Elements to insert at the start of the Array.
     */
    unshift(...items: V[]): number {
        const changeTree = this[$changes];

        // shift indexes
        changeTree.shiftChangeIndexes(items.length);

        // new index
        if (changeTree.isFiltered) {
            setOperationAtIndex(changeTree.filteredChanges, this.items.length);
            // changeTree.filteredChanges[this.items.length] = OPERATION.ADD;
        } else {
            setOperationAtIndex(changeTree.allChanges, this.items.length);
            // changeTree.allChanges[this.items.length] = OPERATION.ADD;
        }

        // FIXME: should we use OPERATION.MOVE here instead?
        items.forEach((_, index) => {
            changeTree.change(index, OPERATION.ADD)
        });

        this.tmpItems.unshift(...items);

        return this.items.unshift(...items);
    }

    /**
     * Returns the index of the first occurrence of a value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at index 0.
     */
    indexOf(searchElement: V, fromIndex?: number): number {
        return this.items.indexOf(searchElement, fromIndex);
    }

    /**
     * Returns the index of the last occurrence of a specified value in an array.
     * @param searchElement The value to locate in the array.
     * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at the last index in the array.
     */
    lastIndexOf(searchElement: V, fromIndex: number = this.length - 1): number {
        return this.items.lastIndexOf(searchElement, fromIndex);
    }

    /**
     * Determines whether all the members of an array satisfy the specified test.
     * @param callbackfn A function that accepts up to three arguments. The every method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value false, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    every<S extends V>(predicate: (value: V, index: number, array: V[]) => value is S, thisArg?: any): this is S[];
    every(callbackfn: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean;
    every(callbackfn: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean {
        return this.items.every(callbackfn, thisArg);
    }

    /**
     * Determines whether the specified callback function returns true for any element of an array.
     * @param callbackfn A function that accepts up to three arguments. The some method calls
     * the callbackfn function for each element in the array until the callbackfn returns a value
     * which is coercible to the Boolean value true, or until the end of the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function.
     * If thisArg is omitted, undefined is used as the this value.
     */
    some(callbackfn: (value: V, index: number, array: V[]) => unknown, thisArg?: any): boolean {
        return this.items.some(callbackfn, thisArg);
    }

    /**
     * Performs the specified action for each element in an array.
     * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the array.
     * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    forEach(callbackfn: (value: V, index: number, array: V[]) => void, thisArg?: any): void {
        return this.items.forEach(callbackfn, thisArg);
    }

    /**
     * Calls a defined callback function on each element of an array, and returns an array that contains the results.
     * @param callbackfn A function that accepts up to three arguments. The map method calls the callbackfn function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    map<U>(callbackfn: (value: V, index: number, array: V[]) => U, thisArg?: any): U[] {
        return this.items.map(callbackfn, thisArg);
    }

    /**
     * Returns the elements of an array that meet the condition specified in a callback function.
     * @param callbackfn A function that accepts up to three arguments. The filter method calls the callbackfn function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
     */
    filter(callbackfn: (value: V, index: number, array: V[]) => unknown, thisArg?: any): V[]
    filter<S extends V>(callbackfn: (value: V, index: number, array: V[]) => value is S, thisArg?: any): V[] {
        return this.items.filter(callbackfn, thisArg);
    }

    /**
     * Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduce method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduce<U=V>(callbackfn: (previousValue: U, currentValue: V, currentIndex: number, array: V[]) => U, initialValue?: U): U {
        return this.items.reduce(callbackfn, initialValue);
    }

    /**
     * Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
     * @param callbackfn A function that accepts up to four arguments. The reduceRight method calls the callbackfn function one time for each element in the array.
     * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
     */
    reduceRight<U=V>(callbackfn: (previousValue: U, currentValue: V, currentIndex: number, array: V[]) => U, initialValue?: U): U {
        return this.items.reduceRight(callbackfn, initialValue);
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
    find(predicate: (value: V, index: number, obj: V[]) => boolean, thisArg?: any): V | undefined {
        return this.items.find(predicate, thisArg);
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
    findIndex(predicate: (value: V, index: number, obj: V[]) => unknown, thisArg?: any): number {
        return this.items.findIndex(predicate, thisArg);
    }

    /**
     * Returns the this object after filling the section identified by start and end with value
     * @param value value to fill array section with
     * @param start index to start filling the array at. If start is negative, it is treated as
     * length+start where length is the length of the array.
     * @param end index to stop filling the array at. If end is negative, it is treated as
     * length+end.
     */
    fill(value: V, start?: number, end?: number): this {
        //
        // TODO
        //
        throw new Error("ArraySchema#fill() not implemented");
        // this.$items.fill(value, start, end);

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
        // TODO
        //
        throw new Error("ArraySchema#copyWithin() not implemented");
        return this;
    }

    /**
     * Returns a string representation of an array.
     */
    toString(): string {
        return this.items.toString();
    }

    /**
     * Returns a string representation of an array. The elements are converted to string using their toLocalString methods.
     */
    toLocaleString(): string {
        return this.items.toLocaleString()
    };

    /** Iterator */
    [Symbol.iterator](): IterableIterator<V> {
        return this.items[Symbol.iterator]();
    }

    static get [Symbol.species]() {
        return ArraySchema;
    }

    // WORKAROUND for compatibility
    // - TypeScript 4 defines @@unscopables as a function
    // - TypeScript 5 defines @@unscopables as an object
    [Symbol.unscopables]: any;

    /**
     * Returns an iterable of key, value pairs for every entry in the array
     */
    entries(): IterableIterator<[number, V]> { return this.items.entries(); }

    /**
     * Returns an iterable of keys in the array
     */
    keys(): IterableIterator<number> { return this.items.keys(); }

    /**
     * Returns an iterable of values in the array
     */
    values(): IterableIterator<V> { return this.items.values(); }

    /**
     * Determines whether an array includes a certain element, returning true or false as appropriate.
     * @param searchElement The element to search for.
     * @param fromIndex The position in this array at which to begin searching for searchElement.
     */
    includes(searchElement: V, fromIndex?: number): boolean {
        return this.items.includes(searchElement, fromIndex);
    }

    //
    // ES2022
    //

    /**
     * Calls a defined callback function on each element of an array. Then, flattens the result into
     * a new array.
     * This is identical to a map followed by flat with depth 1.
     *
     * @param callback A function that accepts up to three arguments. The flatMap method calls the
     * callback function one time for each element in the array.
     * @param thisArg An object to which the this keyword can refer in the callback function. If
     * thisArg is omitted, undefined is used as the this value.
     */
    // @ts-ignore
    flatMap<U, This = undefined>(callback: (this: This, value: V, index: number, array: V[]) => U | ReadonlyArray<U>, thisArg?: This): U[] {
        // @ts-ignore
        throw new Error("ArraySchema#flatMap() is not supported.");
    }

    /**
     * Returns a new array with all sub-array elements concatenated into it recursively up to the
     * specified depth.
     *
     * @param depth The maximum recursion depth
     */
    // @ts-ignore
    flat<A, D extends number = 1>(this: A, depth?: D): any {
        throw new Error("ArraySchema#flat() is not supported.");
    }

    findLast() {
        // @ts-ignore
        return this.items.findLast.apply(this.items, arguments);
    }

    findLastIndex(...args) {
        // @ts-ignore
        return this.items.findLastIndex.apply(this.items, arguments);
    }

    //
    // ES2023
    //
    with(index: number, value: V): ArraySchema<V> {
        const copy = this.items.slice();
        // Allow negative indexing from the end
        if (index < 0) index += this.length;
        copy[index] = value;
        return new ArraySchema(...copy);
    }
    toReversed(): V[] {
        return this.items.slice().reverse();
    }
    toSorted(compareFn?: (a: V, b: V) => number): V[] {
        return this.items.slice().sort(compareFn);
    }
    toSpliced(start: number, deleteCount: number, ...items: V[]): V[];
    toSpliced(start: number, deleteCount?: number): V[];
    // @ts-ignore
    toSpliced(start: unknown, deleteCount?: unknown, ...items?: unknown[]): V[] {
        // @ts-ignore
        return this.items.toSpliced.apply(copy, arguments);
    }

    protected [$getByIndex](index: number, isEncodeAll: boolean = false) {
        //
        // TODO: avoid unecessary `this.tmpItems` check during decoding.
        //
        //    ENCODING uses `this.tmpItems` (or `this.items` if `isEncodeAll` is true)
        //    DECODING uses `this.items`
        //

        return (isEncodeAll)
            ? this.items[index]
            : this.deletedIndexes[index]
                ? this.items[index]
                : this.tmpItems[index] || this.items[index];

        // return (isEncodeAll)
        //     ? this.items[index]
        //     : this.tmpItems[index] ?? this.items[index];
    }

    protected [$deleteByIndex](index: number) {
        this.items[index] = undefined;
        this.tmpItems[index] = undefined; // TODO: do not try to get "tmpItems" at decoding time.
    }

    protected [$onEncodeEnd]() {
        this.tmpItems = this.items.slice();
        this.deletedIndexes = {};
    }

    protected [$onDecodeEnd]() {
        this.items = this.items.filter((item) => item !== undefined);
        this.tmpItems = this.items.slice(); // TODO: do no use "tmpItems" at decoding time.
    }

    toArray() {
        return this.items.slice(0);
    }

    toJSON() {
        return this.toArray().map((value) => {
            return (typeof (value['toJSON']) === "function")
                ? value['toJSON']()
                : value;
        });
    }

    //
    // Decoding utilities
    //
    clone(isDecoding?: boolean): ArraySchema<V> {
        let cloned: ArraySchema;

        if (isDecoding) {
            cloned = new ArraySchema();
            cloned.push(...this.items);

        } else {
            cloned = new ArraySchema(...this.map(item => (
                (item[$changes])
                    ? (item as any as Schema).clone()
                    : item
            )));
        }

        return cloned;
    };

}

registerType("array", { constructor: ArraySchema });