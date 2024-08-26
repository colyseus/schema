import { OPERATION } from "../../encoding/spec";
import { registerType } from "../registry";
import { $changes, $childType, $decoder, $deleteByIndex, $encoder, $filter, $getByIndex } from "../symbols";
import { Collection } from "../HelperTypes";
import { ChangeTree } from "../../encoder/ChangeTree";
import { encodeKeyValueOperation } from "../../encoder/EncodeOperation";
import { decodeKeyValueOperation } from "../../decoder/DecodeOperation";
import type { StateView } from "../../encoder/StateView";

export class SetSchema<V=any> implements Collection<number, V> {

    protected $items: Map<number, V> = new Map<number, V>();
    protected $indexes: Map<number, number> = new Map<number, number>();

    protected $refId: number = 0;

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
    static [$filter] (ref: SetSchema, index: number, view: StateView) {
        return (
            !view ||
            typeof (ref[$childType]) === "string" ||
            view.items.has(ref[$getByIndex](index)[$changes])
        );
    }

    static is(type: any) {
        return type['set'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
        this[$changes] = new ChangeTree(this);
        this[$changes].indexes = {};

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
        // immediatelly return false if value already added.
        if (this.has(value)) { return false; }

        // set "index" for reference.
        const index = this.$refId++;

        if ((value[$changes]) !== undefined) {
            value[$changes].setParent(this, this[$changes].root, index);
        }

        const operation = this[$changes].indexes[index]?.op ?? OPERATION.ADD;

        this[$changes].indexes[index] = index;

        this.$indexes.set(index, index);
        this.$items.set(index, value);

        this[$changes].change(index, operation);
        return index;
    }

    entries () {
        return this.$items.entries();
    }

    delete(item: V) {
        const entries = this.$items.entries();

        let index: number;
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

    has (value: V): boolean {
        const values = this.$items.values();

        let has = false;
        let entry: IteratorResult<V>;

        while (entry = values.next()) {
            if (entry.done) { break; }
            if (value === entry.value) {
                has = true;
                break;
            }
        }

        return has;
    }

    forEach(callbackfn: (value: V, key: number, collection: SetSchema<V>) => void) {
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
    clone(isDecoding?: boolean): SetSchema<V> {
        let cloned: SetSchema;

        if (isDecoding) {
            // client-side
            cloned = Object.assign(new SetSchema(), this);

        } else {
            // server-side
            cloned = new SetSchema();
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

registerType("set", { constructor: SetSchema });