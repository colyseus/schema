import { $changes, $childType, $decoder, $deleteByIndex, $encoder, $getByIndex } from "../symbols";
import { ChangeTree } from "../../encoder/ChangeTree";
import { OPERATION } from "../../encoding/spec";
import { registerType } from "../registry";
import { Collection } from "../HelperTypes";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation";

export class MapSchema<V=any, K extends string = string> implements Map<K, V>, Collection<K, V, [K, V]> {
    protected childType: new () => V;

    protected $items: Map<K, V> = new Map<K, V>();
    protected $indexes: Map<number, K> = new Map<number, K>();

    static [$encoder] = encodeKeyValueOperation;
    static [$decoder] = decodeKeyValueOperation;

    static is(type: any) {
        return type['map'] !== undefined;
    }

    constructor (initialValues?: Map<K, V> | Record<K, V>) {
        this[$changes] = new ChangeTree(this);

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
        }

        // Force "key" as string
        // See: https://github.com/colyseus/colyseus/issues/561#issuecomment-1646733468
        key = key.toString() as K;

        const changeTree = this[$changes];

        // get "index" for this value.
        const isReplace = typeof(changeTree.indexes[key]) !== "undefined";

        const index = (isReplace)
            ? changeTree.indexes[key]
            : changeTree.indexes[-1] ?? 0;

        let operation: OPERATION = (isReplace)
            ? OPERATION.REPLACE
            : OPERATION.ADD;

        const isRef = (value[$changes]) !== undefined;

        //
        // (encoding)
        // set a unique id to relate directly with this key/value.
        //
        if (!isReplace) {
            this.$indexes.set(index, key);
            changeTree.indexes[key] = index;
            changeTree.indexes[-1] = index + 1;

        } else if (
            !isRef &&
            this.$items.get(key) === value
        ) {
            // if value is the same, avoid re-encoding it.
            return;

        } else if (
            isRef && // if is schema, force ADD operation if value differ from previous one.
            this.$items.get(key) !== value
        ) {
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
        //
        // TODO: add a "purge" method after .encode() runs, to cleanup removed `$indexes`
        //
        // We don't remove $indexes to allow setting the same key in the same patch
        // (See "should allow to remove and set an item in the same place" test)
        //
        // // const index = this.$changes.indexes[key];
        // // this.$indexes.delete(index);

        const index = this[$changes].indexes[key];

        this[$changes].delete(index);

        return this.$items.delete(key);
    }

    clear() {
        // discard previous operations.
        this[$changes].discard(true, true);
        this[$changes].indexes = {};

        // clear previous indexes
        this.$indexes.clear();

        // clear items
        this.$items.clear();

        this[$changes].operation({ index: 0, op: OPERATION.CLEAR });
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