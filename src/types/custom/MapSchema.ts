import { $changes, $childType, $decoder, $deleteByIndex, $onEncodeEnd, $encoder, $filter, $getByIndex, $numFields } from "../symbols";
import { ChangeTree } from "../../encoder/ChangeTree";
import { OPERATION } from "../../encoding/spec";
import { registerType } from "../registry";
import { Collection } from "../HelperTypes";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation";
import type { StateView } from "../../encoder/StateView";
import type { Schema } from "../../Schema";
import { assertInstanceType } from "../../encoding/assert";

export class MapSchema<V=any, K extends string = string> implements Map<K, V>, Collection<K, V, [K, V]> {
    protected childType: new () => V;

    protected $items: Map<K, V> = new Map<K, V>();
    protected $indexes: Map<number, K> = new Map<number, K>();
    protected deletedItems: { [field: string]: V } = {};

    protected [$changes]: ChangeTree;

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
        return (
            !view ||
            typeof (ref[$childType]) === "string" ||
            view.items.has((ref[$getByIndex](index) ?? ref.deletedItems[index])[$changes])
        );
    }

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<K, V> | Record<K, V>) {
        this[$changes] = new ChangeTree(this);
        this[$changes].indexes = {};

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

        Object.defineProperty(this, $childType, {
            value: undefined,
            enumerable: false,
            writable: true,
            configurable: true,
        });
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

        let index: number;
        let operation: OPERATION;

        // IS REPLACE?
        if (typeof(changeTree.indexes[key]) !== "undefined") {
            index = changeTree.indexes[key];
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

        } else {
            index = changeTree.indexes[$numFields] ?? 0;
            operation = OPERATION.ADD;

            this.$indexes.set(index, key);
            changeTree.indexes[key] = index;
            changeTree.indexes[$numFields] = index + 1;
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
        const index = this[$changes].indexes[key];

        this.deletedItems[index] = this[$changes].delete(index);;

        return this.$items.delete(key);
    }

    clear() {
        const changeTree = this[$changes];

        // discard previous operations.
        changeTree.discard(true);
        changeTree.indexes = {};

        // clear previous indexes
        this.$indexes.clear();

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

    protected setIndex(index: number, key: K) {
        this.$indexes.set(index, key);
    }

    protected getIndex(index: number) {
        return this.$indexes.get(index);
    }

    protected [$getByIndex](index: number) {
        return this.$items.get(this.$indexes.get(index));
    }

    protected [$deleteByIndex](index: number) {
        const key = this.$indexes.get(index);
        this.$items.delete(key);
        this.$indexes.delete(index);
    }

    protected [$onEncodeEnd]() {
        this.deletedItems = {};
    }

    toJSON() {
        const map: any = {};

        this.forEach((value, key) => {
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

            this.forEach((value, key) => {
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