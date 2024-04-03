import { ChangeTree } from "../../encoder/ChangeTree";
import { OPERATION } from "../../encoding/spec";
import { removeChildRefs } from "../utils";
import { registerType } from "../registry";
import { $changes, $childType, $deleteByIndex, $getByIndex } from "../symbols";
import { DataChange } from "../../decoder/DecodeOperation";
import { Collection } from "../HelperTypes";

export class SetSchema<V=any> implements Collection<number, V> {

    protected $items: Map<number, V> = new Map<number, V>();
    protected $indexes: Map<number, number> = new Map<number, number>();

    protected $refId: number = 0;

    static is(type: any) {
        return type['set'] !== undefined;
    }

    constructor (initialValues?: Array<V>) {
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

    clear(changes?: DataChange[]) {
        // discard previous operations.
        this[$changes].discard(true, true);
        this[$changes].indexes = {};

        // clear previous indexes
        this.$indexes.clear();

        //
        // When decoding:
        // - enqueue items for DELETE callback.
        // - flag child items for garbage collection.
        //
        if (changes) {
            removeChildRefs.call(this, changes);
        }

        // clear items
        this.$items.clear();

        // @ts-ignore
        this[$changes].operation({ index: 0, op: OPERATION.CLEAR });

        // // touch all structures until reach root
        // this.$changes.touchParents();
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
                if (value['$changes']) {
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