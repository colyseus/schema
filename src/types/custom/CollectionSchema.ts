import { $changes, $childType, $decoder, $deleteByIndex, $encoder, $getByIndex } from "../symbols";
import { ChangeTree } from "../../encoder/ChangeTree";
import { OPERATION } from "../../encoding/spec";
import { registerType } from "../registry";
import { Collection } from "../HelperTypes";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation";

type K = number; // TODO: allow to specify K generic on MapSchema.

export class CollectionSchema<V=any> implements Collection<K, V>{
    protected $items: Map<number, V> = new Map<number, V>();
    protected $indexes: Map<number, number> = new Map<number, number>();

    protected $refId: number = 0;

    static [$encoder] = encodeKeyValueOperation;
    static [$decoder] = decodeKeyValueOperation;

    static is(type: any) {
        return type['collection'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
        this[$changes] = new ChangeTree(this);

        if (initialValues) {
            initialValues.forEach((v) => this.add(v));
        }

        Object.defineProperty(this, $childType, {
            value: undefined,
            enumerable: false,
            writable: true,
            configurable: true,
        });
    }

    add(value: V) {
        // set "index" for reference.
        const index = this.$refId++;

        const isRef = (value[$changes]) !== undefined;
        if (isRef) {
            value[$changes].setParent(this, this[$changes].root, index);
        }

        this[$changes].indexes[index] = index;

        this.$indexes.set(index, index);
        this.$items.set(index, value);

        this[$changes].change(index);

        return index;
    }

    at(index: number): V | undefined {
        const key = Array.from(this.$items.keys())[index];
        return this.$items.get(key);
    }

    entries() {
        return this.$items.entries();
    }

    delete(item: V) {
        const entries = this.$items.entries();

        let index: K;
        let entry: IteratorResult<[number, V]>;
        while (entry = entries.next()) {
            if (entry.done) { break; }

            if (item === entry.value[1]) {
                index = entry.value[0];
                break;
            }
        }

        if (index === undefined) {
            return false;
        }

        this[$changes].delete(index);
        this.$indexes.delete(index);

        return this.$items.delete(index);
    }

    clear() {
        // discard previous operations.
        this[$changes].discard(true);
        this[$changes].indexes = {};

        // clear previous indexes
        this.$indexes.clear();

        // clear items
        this.$items.clear();

        // @ts-ignore
        this[$changes].operation({ index: -1, op: OPERATION.CLEAR });

        // // touch all structures until reach root
        // this[$changes].touchParents();
    }

    has (value: V): boolean {
        return Array.from(this.$items.values()).some((v) => v === value);
    }

    forEach(callbackfn: (value: V, key: K, collection: CollectionSchema<V>) => void) {
        this.$items.forEach((value, key, _) => callbackfn(value, key, this));
    }

    values() {
        return this.$items.values();
    }

    get size () {
        return this.$items.size;
    }

    /** Iterator */
    [Symbol.iterator](): IterableIterator<V> {
        return this.$items.values();
    }

    protected setIndex(index: number, key: number) {
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

    toArray() {
        return Array.from(this.$items.values());
    }

    toJSON() {
        const values: V[] = [];

        this.forEach((value, key) => {
            values.push(
                (typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value
            );
        });

        return values;
    }

    //
    // Decoding utilities
    //
    clone(isDecoding?: boolean): CollectionSchema<V> {
        let cloned: CollectionSchema;

        if (isDecoding) {
            // client-side
            cloned = Object.assign(new CollectionSchema(), this);

        } else {
            // server-side
            cloned = new CollectionSchema();
            this.forEach((value) => {
                if (value[$changes]) {
                    cloned.add(value['clone']());
                } else {
                    cloned.add(value);
                }
            })
        }

        return cloned;
    }

}

registerType("collection", { constructor: CollectionSchema, });