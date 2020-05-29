import { ChangeTree } from "../ChangeTree";
import { Schema } from "../Schema";

export class ArraySchema<T=any> extends Array<T> {
    protected $sorting: boolean;
    protected $changes: ChangeTree;
    // protected $cache: Map<number, T> = new Map<number, T>();

    static get [Symbol.species](): any { return ArraySchema; }

    static is(type: any) {
        return Array.isArray(type);
    }

    constructor (...items: T[]) {
        super(...items);

        Object.setPrototypeOf(this, Object.create(ArraySchema.prototype));
        Object.defineProperties(this, {
            $sorting:     { value: undefined, enumerable: false, writable: true },
            $changes:     { value: undefined, enumerable: false, writable: true },

            onAdd:        { value: undefined, enumerable: false, writable: true },
            onRemove:     { value: undefined, enumerable: false, writable: true },
            onChange:     { value: undefined, enumerable: false, writable: true },

            triggerAll: {
                value: () => {
                    if (!this.onAdd) {
                        return;
                    }

                    for (let i = 0; i < this.length; i++) {
                        this.onAdd(this[i], i);
                    }
                }
            },

            toJSON: {
                value: () => {
                    const arr = [];
                    for (let i = 0; i < this.length; i++) {
                        const objAt = this[i] as any;
                        arr.push(
                            (typeof (objAt.toJSON) === "function")
                                ? objAt.toJSON()
                                : objAt
                        );
                    }
                    return arr;
                }
            },

            clone: {
                value: (isDecoding?: boolean) => {
                    let cloned: ArraySchema;

                    if (isDecoding) {
                        cloned = ArraySchema.of(...this) as ArraySchema;
                        cloned.onAdd = this.onAdd;
                        cloned.onRemove = this.onRemove;
                        cloned.onChange = this.onChange;

                    } else {
                        cloned = new ArraySchema(...this.map(item => {
                            if (typeof (item) === "object") {
                                return (item as any as Schema).clone();
                            } else {
                                return item;
                            }
                        }));
                    }

                    return cloned;
                }
            }
        });
    }

    clone: (isDecoding?: boolean) => ArraySchema<T>;
    sort(compareFn?: (a: T, b: T) => number): this {
        this.$sorting = true;
        super.sort(compareFn);

        if (this.$changes) { // allow to .slice() + .sort()
            const changes = Array.from(this.$changes.changes);
            for (const key of changes) {
                // track index change
                const previousIndex = this.$changes.getIndex(this[key]);
                if (previousIndex !== undefined) {
                    this.$changes.mapIndexChange(this[key], previousIndex);
                }
                this.$changes.mapIndex(this[key], key);
            }
        }

        this.$sorting = false;
        return this;
    }

    filter(callbackfn: (value: T, index: number, array: T[]) => unknown, thisArg?: any): ArraySchema<T> {
        const filtered = super.filter(callbackfn);

        (filtered as any).$changes = this.$changes.clone();

        return filtered as ArraySchema<T>;
    }

    splice(start: number, deleteCount?: number, ...insert: T[]) {
        const removedItems = Array.prototype.splice.apply(this, arguments);
        const movedItems = Array.prototype.filter.call(this, (item, idx) => {
            return idx >= start + deleteCount - 1;
        });

        removedItems.map(removedItem => {
            const $changes = removedItem && (removedItem as any).$changes;
            // If the removed item is a schema we need to update it.
            if ($changes) {
                $changes.parent.deleteIndex(removedItem);
                delete $changes.parent;
            }
        });

        movedItems.forEach(movedItem => {
            // If the moved item is a schema we need to update it.
            const $changes = movedItem && (movedItem as any).$changes;

            if ($changes) {
                // Update current index in parent, so subsequent changes in
                // this item's properties are correctly reflected.
                $changes.parentField--;
            }

        });

        return removedItems;
    }

    onAdd: (item: T, index: number) => void;
    onRemove: (item: T, index: number) => void;
    onChange: (item: T, index: number) => void;

    triggerAll: () => void;
}
